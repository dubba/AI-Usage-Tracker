package com.dubba.ai.usage.tracker

/**
 * Which downloaded updates the in-app updater may hand to the system installer.
 *
 * An update must be signed by exactly the certificates that sign the installed
 * app now. Comparing against the installed app's certificate history instead
 * would also accept a certificate the app has since rotated away from. After a
 * deliberate key rotation, in-app updates therefore stop and the new version is
 * installed manually once; the system installer would make the final call either way.
 */
object UpdateSigners {
  fun match(installed: Set<String>, update: Set<String>): Boolean =
    installed.isNotEmpty() && installed == update
}
