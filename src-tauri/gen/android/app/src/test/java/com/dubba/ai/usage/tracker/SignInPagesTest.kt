package com.dubba.ai.usage.tracker

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SignInPagesTest {
  @Test
  fun theConnectedPageTheAppMakesIsAResultPage() {
    assertTrue(SignInPages.isResultPage("data:text/html;charset=utf-8;base64,PGh0bWw+"))
  }

  @Test
  fun loopbackRedirectsAreResultPagesWhateverTheirPath() {
    for (url in listOf(
      "http://localhost:1455/auth/callback?code=x&state=y",
      "http://localhost:1455/callback?code=x&state=y",
      // Google redirects to the bare origin, with no "callback" in the path.
      "http://127.0.0.1:11461/?code=x&state=y&scope=a",
      "http://127.0.0.1:11461/?state=y&error=access_denied",
      "http://localhost:1455/auth/callback",
    )) {
      assertTrue(url, SignInPages.isResultPage(url))
    }
  }

  @Test
  fun providerAndAppPagesAreNotResultPages() {
    for (url in listOf(
      null,
      "",
      "about:blank",
      "https://accounts.google.com/o/oauth2/auth?client_id=x",
      "https://claude.ai/login",
      "https://localhost:1455/?code=x",
      "http://tauri.localhost/",
      "http://127.0.0.1:11461/",
      "http://127.0.0.1:11461/?other=1",
      "http://evil.example/?code=x",
    )) {
      assertFalse(url.toString(), SignInPages.isResultPage(url))
    }
  }
}
