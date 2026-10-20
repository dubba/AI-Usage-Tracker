package com.dubba.ai.usage.tracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SignInTabTest {
  private var clock = 0L
  private val tab = SignInTab { clock }

  private fun pass(millis: Long) {
    clock += millis
  }

  @Test
  fun closingTheTabCountsOnceItWasHiddenWithoutAMinimizeReport() {
    // Seen on an emulator: the activity resumes, then about a second later the tab is hidden.
    val id = tab.opened()
    tab.activityResumed()
    pass(1200)
    assertFalse(tab.takeClosedByUser(id))
    tab.hidden()
    pass(SignInTab.AFTER_HIDDEN_MS - 1)
    assertFalse(tab.takeClosedByUser(id))
    pass(1)
    assertTrue(tab.takeClosedByUser(id))
    assertFalse(tab.takeClosedByUser(id))
    // The tab is gone, so the app has nothing to return over.
    assertFalse(tab.returning(id))
  }

  @Test
  fun minimizingTheTabIsNotAClose() {
    // Seen on an emulator: the activity resumes, and two seconds later the tab is hidden and
    // reported minimized together.
    val id = tab.opened()
    tab.activityResumed()
    pass(1900)
    tab.hidden()
    tab.minimized()
    pass(60_000)
    assertFalse(tab.takeClosedByUser(id))
    // Reported before the resume.
    val next = tab.opened()
    tab.hidden()
    tab.minimized()
    tab.activityResumed()
    pass(60_000)
    assertFalse(tab.takeClosedByUser(next))
    // Still open: the app returns over it once the sign-in ends.
    assertTrue(tab.returning(next))
  }

  @Test
  fun aMinimizeReportShortlyAfterTheTabIsHiddenStillCounts() {
    val id = tab.opened()
    tab.activityResumed()
    tab.hidden()
    pass(SignInTab.AFTER_HIDDEN_MS / 2)
    tab.minimized()
    pass(60_000)
    assertFalse(tab.takeClosedByUser(id))
  }

  @Test
  fun aRestoredTabThatIsThenClosedCountsAsClosed() {
    val id = tab.opened()
    tab.activityResumed()
    tab.hidden()
    tab.minimized()
    tab.unminimized()
    tab.shown()
    pass(60_000)
    assertFalse(tab.takeClosedByUser(id))
    tab.activityResumed()
    tab.hidden()
    pass(SignInTab.AFTER_HIDDEN_MS)
    assertTrue(tab.takeClosedByUser(id))
  }

  @Test
  fun leavingForAnotherAppAndComingBackToTheTabIsNotAClose() {
    val id = tab.opened()
    tab.hidden()
    tab.shown()
    pass(60_000)
    assertFalse(tab.takeClosedByUser(id))
  }

  @Test
  fun aBrowserThatReportsNothingCountsAsClosedAfterTheLongerWait() {
    val id = tab.opened()
    tab.activityResumed()
    pass(SignInTab.WITHOUT_REPORT_MS - 1)
    assertFalse(tab.takeClosedByUser(id))
    pass(1)
    assertTrue(tab.takeClosedByUser(id))
  }

  @Test
  fun theAppReturningOverTheTabIsNotAClose() {
    val id = tab.opened()
    assertTrue(tab.returning(id))
    tab.activityResumed()
    tab.hidden()
    pass(60_000)
    assertFalse(tab.takeClosedByUser(id))
    assertFalse(tab.returning(id))
  }

  @Test
  fun resumingWithoutATabIsNotAClose() {
    tab.activityResumed()
    tab.hidden()
    pass(60_000)
    assertFalse(tab.takeClosedByUser(0))
    assertFalse(tab.returning(0))
  }

  @Test
  fun anEndedSignInCannotCloseOrCancelANewerTab() {
    val old = tab.opened()
    val newer = tab.opened()
    assertNotEquals(old, newer)
    tab.activityResumed()
    tab.hidden()
    pass(SignInTab.AFTER_HIDDEN_MS)
    assertFalse(tab.returning(old))
    assertFalse(tab.takeClosedByUser(old))
    assertTrue(tab.takeClosedByUser(newer))
  }

  @Test
  fun aNewTabForgetsWhatHappenedToTheLastOne() {
    tab.opened()
    tab.activityResumed()
    tab.hidden()
    tab.minimized()
    val next = tab.opened()
    pass(60_000)
    assertFalse(tab.takeClosedByUser(next))
    assertEquals(2, next)
    tab.activityResumed()
    tab.hidden()
    pass(SignInTab.AFTER_HIDDEN_MS)
    assertTrue(tab.takeClosedByUser(next))
  }

  @Test
  fun onlyHttpsPagesOpenInTheTab() {
    assertTrue(SignInTab.isAllowedUrl("https://claude.ai/oauth/authorize?code=true&state=x"))
    assertTrue(SignInTab.isAllowedUrl("https://accounts.google.com/o/oauth2/auth?prompt=select_account+consent"))
    for (url in listOf(
      null,
      "",
      "http://claude.ai/oauth/authorize",
      "HTTPS://claude.ai/oauth/authorize",
      "intent://claude.ai#Intent;scheme=https;end",
      "javascript:alert(1)",
      "file:///data/data/com.dubba.ai.usage.tracker/",
      "content://com.dubba.ai.usage.tracker.fileprovider/updates/x.apk",
      "https://user:pass@claude.ai/",
      "https:///no-host",
      "https://claude.ai/" + "a".repeat(9000),
    )) {
      assertFalse(url, SignInTab.isAllowedUrl(url))
    }
  }
}
