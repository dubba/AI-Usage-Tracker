package com.dubba.ai.usage.tracker

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateSignersTest {
  @Test
  fun anUpdateSignedByTheCurrentCertificateIsAccepted() {
    assertTrue(UpdateSigners.match(setOf("current"), setOf("current")))
  }

  @Test
  fun aCertificateTheAppRotatedAwayFromIsRejected() {
    // The installed app's history would still list "retired"; only the current signer counts.
    assertFalse(UpdateSigners.match(setOf("current"), setOf("retired")))
  }

  @Test
  fun signerSetsMustMatchExactly() {
    assertFalse(UpdateSigners.match(setOf("current"), setOf("current", "other")))
    assertFalse(UpdateSigners.match(setOf("current", "other"), setOf("current")))
  }

  @Test
  fun missingSignerInformationFailsClosed() {
    assertFalse(UpdateSigners.match(emptySet(), emptySet()))
    assertFalse(UpdateSigners.match(emptySet(), setOf("current")))
    assertFalse(UpdateSigners.match(setOf("current"), emptySet()))
  }
}
