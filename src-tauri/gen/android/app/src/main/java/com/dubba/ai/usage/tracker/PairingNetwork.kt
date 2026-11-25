package com.dubba.ai.usage.tracker

import android.app.Activity
import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build

/**
 * What Link Devices needs from the phone's network: the Wi-Fi state, and the multicast lock and
 * Wi-Fi binding held while a pairing session runs, plus native Android NSD (mDNS/Bonjour)
 * advertisement so iOS/macOS `mDNSResponder` resolves Android hosts reliably.
 * `MainActivity` forwards Rust's JNI calls here.
 */
internal class PairingNetwork(private val activity: Activity) {
  private var multicastLock: android.net.wifi.WifiManager.MulticastLock? = null
  private var boundLanNetwork: Boolean = false
  /** A pairing session is running (between `setLanBinding(true)` and `setLanBinding(false)`). */
  private var pairingActive: Boolean = false
  private val nsdLock = Any()
  private var nsdListener: NsdManager.RegistrationListener? = null

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
   * Whether this phone is connected to a Wi-Fi network (including another phone's hotspot), for
   * the Sync Devices log. The radio being on is not enough: on a Pixel it is often on with no
   * network. A hotspot this phone shares is not checked. True if the check itself throws.
   */
  fun isWifiEnabled(): Boolean {
    return try {
      wifiNetwork(connectivity()) != null
    } catch (e: Throwable) {
      android.util.Log.w(LOG_TAG, "isWifiEnabled failed: ${e.message}")
      true
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
    val apply = Runnable {
      pairingActive = enabled
      setMulticastLock(enabled)
      try {
        val cm = connectivity()
        if (enabled) {
          if (boundLanNetwork) return@Runnable
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
    if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
      apply.run()
      return
    }
    val done = java.util.concurrent.CountDownLatch(1)
    activity.runOnUiThread {
      try {
        apply.run()
      } finally {
        done.countDown()
      }
    }
    done.await(2, java.util.concurrent.TimeUnit.SECONDS)
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

  /**
   * Advertises this pairing host via Android's native `NsdManager` (RFC 6762/6763 responder),
   * which supports QU unicast responses, IPv4+IPv6 answers, and clean TTL=0 goodbye packets for
   * Apple's `mDNSResponder`. Returns true once registered, or false so Rust can fall back.
   */
  fun registerMdnsService(
    instanceName: String,
    port: Int,
    sessionId: String,
    nonce: String,
    version: String,
  ): Boolean {
    unregisterMdnsService()
    val nsd = try {
      activity.applicationContext.getSystemService(Context.NSD_SERVICE) as? NsdManager
    } catch (e: Throwable) {
      android.util.Log.w(LOG_TAG, "NSD service unavailable: ${e.message}")
      return false
    } ?: return false

    val info = NsdServiceInfo().apply {
      serviceName = instanceName
      serviceType = "_aiut-pair._tcp"
      setPort(port)
      setAttribute("sid", sessionId)
      setAttribute("nonce", nonce)
      setAttribute("v", version)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      try {
        wifiNetwork(connectivity())?.let { wifi ->
          info.network = wifi
        }
      } catch (e: Throwable) {
        android.util.Log.w(LOG_TAG, "Binding NSD registration to Wi-Fi failed: ${e.message}")
      }
    }

    val done = java.util.concurrent.CountDownLatch(1)
    val registered = java.util.concurrent.atomic.AtomicBoolean(false)
    val listener = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
        registered.set(true)
        done.countDown()
      }

      override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
        android.util.Log.w(LOG_TAG, "NSD registration failed (code $errorCode)")
        done.countDown()
      }

      override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {}

      override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
        android.util.Log.w(LOG_TAG, "NSD unregistration failed (code $errorCode)")
      }
    }

    try {
      synchronized(nsdLock) {
        nsdListener = listener
      }
      nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
      done.await(3, java.util.concurrent.TimeUnit.SECONDS)
      if (!registered.get()) {
        unregisterMdnsService()
        return false
      }
      return true
    } catch (e: Throwable) {
      android.util.Log.w(LOG_TAG, "NSD registerService threw: ${e.message}")
      synchronized(nsdLock) {
        if (nsdListener === listener) nsdListener = null
      }
      return false
    }
  }

  /** Stops the active `NsdManager` advertisement (if any) so Android sends a goodbye packet. */
  fun unregisterMdnsService() {
    val listener = synchronized(nsdLock) {
      val current = nsdListener
      nsdListener = null
      current
    } ?: return
    try {
      val nsd = activity.applicationContext.getSystemService(Context.NSD_SERVICE) as? NsdManager
      nsd?.unregisterService(listener)
    } catch (e: Throwable) {
      android.util.Log.w(LOG_TAG, "NSD unregisterService failed: ${e.message}")
    }
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
