package com.dubba.ai.usage.tracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertNotificationsTest {
  @Test
  fun burstCallsProduceDistinctPositiveNotificationIds() {
    val count = 1000
    val ids = (1..count).map { AlertNotifications.nextNotificationId() }

    // Every ID in the burst must be unique
    assertEquals(count, ids.toSet().size)

    // Every ID must be a positive integer
    for (id in ids) {
      assertTrue("ID $id should be > 0", id > 0)
    }
  }
}
