package com.dubba.ai.usage.tracker

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SignInPagesTest {
  /** The cases the Rust rule (`result_pages_match_the_shared_cases`) is tested against too. */
  @Test
  fun loopbackRedirectsMatchTheSharedCases() {
    // Unit tests run in the app module's folder (src-tauri/gen/android/app).
    val cases = File("../../../src/auth/result_page_cases.txt")
    assertTrue("missing ${cases.absolutePath}", cases.isFile)
    var count = 0
    for (line in cases.readLines().map { it.trim() }) {
      if (line.isEmpty() || line.startsWith("#")) continue
      val expected = line.substringBefore(' ').toBooleanStrict()
      val url = line.substringAfter(' ')
      assertEquals(url, expected, SignInPages.isResultPage(url))
      count++
    }
    assertTrue(count >= 20)
  }

  @Test
  fun theConnectedPageTheAppMakesIsAResultPage() {
    assertTrue(SignInPages.isResultPage("data:text/html;charset=utf-8;base64,PGh0bWw+"))
  }

  @Test
  fun nothingIsNotAResultPage() {
    assertFalse(SignInPages.isResultPage(null))
    assertFalse(SignInPages.isResultPage(""))
    assertFalse(SignInPages.isResultPage("not a url at all"))
  }
}
