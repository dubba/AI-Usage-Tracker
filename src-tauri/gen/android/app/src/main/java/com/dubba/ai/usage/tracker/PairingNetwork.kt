package com.dubba.ai.usage.tracker

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings

/**
 * What Link Devices needs from the phone's network: the Wi-Fi state, and the multicast lock and
 * Wi-Fi binding held while a pairing session runs. `MainActivity` forwards Rust's JNI calls here.
 */
internal class PairingNetwork(private val activity: Activity) {
  private var multicastLock: android.net.wifi.WifiManager.MulticastLock? = null
  private var boundLanNetwork: Boolean = false
  /** A pairing session is running (between `setLanBinding(true)` and `setLanBinding(false)`). */
  private var pairingActive: Boolean = false

  /**
   * Pairing (Link Devices) finds peers with mDNS over multicast, and Android filters
   * inbound multicast unless the app holds a MulticastLock; without it, code joins
   * time out on the phone. The lock keeps the Wi-Fi radio processing multicast, which
   * costs battery, so it is held only while a pairing session runs.
   */
  private fun setMulticastLock(enabled: Boolean) {
    try {
      if (enabled) {
        if (multicastLock?.isHeld == true) return
        val wifiManager = activity.applicationContext.getSystemService(Context.WIFI_SERVICE)
          as android.net.wifi.WifiManager
        multicastLock = wifiManager.createMulticastLock("aiut-pairing").apply {
          setReferenceCounted(false)
          acquire()
        }
      } else {
        multicastLock?.takeIf { it.isHeld }?.release()
        multicastLock = null
      }
    } catch (e: Throwable) {
      android.util.Log.w(LOG_TAG, "Updating the pairing multicast lock failed: ${e.message}")
    }
  }

  /**
   * Whether the Wi-Fi radio is on. Link-code pairing asks this first so the
   * app can send the user to the system Wi-Fi panel. Fail-open (true) if the
   * check itself throws, so a broken probe cannot block pairing.
   */
  @Suppress("DEPRECATION")
  fun isWifiEnabled(): Boolean {
    return try {
      val wifiManager = activity.applicationContext.getSystemService(Context.WIFI_SERVICE)
        as android.net.wifi.WifiManager
      wifiManager.isWifiEnabled
    } catch (e: Throwable) {
      android.util.Log.w(LOG_TAG, "isWifiEnabled failed: ${e.message}")
      true
    }
  }

  fun openWifiSettings() {
    activity.runOnUiThread {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          try {
            activity.startActivity(Intent(Settings.Panel.ACTION_WIFI))
            return@runOnUiThread
          } catch (_: Exception) {
          }
        }
        activity.startActivity(Intent(Settings.ACTION_WIFI_SETTINGS))
      } catch (e: Throwable) {
        android.util.Log.w(LOG_TAG, "openWifiSettings failed: ${e.message}")
      }
    }
  }

  /**
   * Called from Rust when a Link Devices session starts/stops. While a VPN or
   * DNS-based ad blocker is running, Android routes ALL app traffic through the
   * VPN tunnel — including LAN packets — which silently breaks pairing. Binding
   * the process to the Wi-Fi network for the duration of the pairing session
   * keeps the LAN connection working.
   */
  fun setLanBinding(enabled: Boolean) {
    activity.runOnUiThread {
      pairingActive = enabled
      setMulticastLock(enabled)
      try {
        val cm = connectivity()
        if (enabled) {
          if (boundLanNetwork) return@runOnUiThread
          val wifi = wifiNetwork(cm)
          boundLanNetwork = if (wifi != null) {
            cm.bindProcessToNetwork(wifi)
          } else {
            false
          }
        } else {
          if (boundLanNetwork) {
            cm.bindProcessToNetwork(null)
            boundLanNetwork = false
          }
        }
      } catch (e: Throwable) {
        android.util.Log.w(LOG_TAG, "setPairingLanBinding failed: ${e.message}")
      }
    }
  }

  /**
   * Called from Rust before the joining device connects, with the name of the local interface on
   * the other device's subnet. The tie to Wi-Fi above stays only when that is the Wi-Fi
   * network's interface. A phone that shares its hotspot while also on Wi-Fi reaches a device on
   * its hotspot through the hotspot interface, which apps cannot bind to; tied to the Wi-Fi, the
   * connection would go out the wrong way and fail. Waits until it has run, so the connection
   * that follows uses the new routing.
   */
  fun routePairingTo(interfaceName: String) {
    val done = java.util.concurrent.CountDownLatch(1)
    activity.runOnUiThread {
      try {
        if (pairingActive) {
          val cm = connectivity()
          val wifi = wifiNetwork(cm)
          val peerOnWifi = wifi != null &&
            cm.getLinkProperties(wifi)?.interfaceName == interfaceName
          if (peerOnWifi && !boundLanNetwork) {
            boundLanNetwork = cm.bindProcessToNetwork(wifi)
          } else if (!peerOnWifi && boundLanNetwork) {
            cm.bindProcessToNetwork(null)
            boundLanNetwork = false
          }
        }
      } catch (e: Throwable) {
        android.util.Log.w(LOG_TAG, "routePairingTo failed: ${e.message}")
      } finally {
        done.countDown()
      }
    }
    done.await(2, java.util.concurrent.TimeUnit.SECONDS)
  }

  private fun connectivity(): android.net.ConnectivityManager =
    activity.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE)
      as android.net.ConnectivityManager

  private fun wifiNetwork(cm: android.net.ConnectivityManager): android.net.Network? =
    cm.allNetworks.firstOrNull { network ->
      cm.getNetworkCapabilities(network)
        ?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) == true
    }
}
