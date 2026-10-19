use super::*;

// The "Weekly Grok Bot Limit" on grok.com Settings → Usage is not part of the
// billing RPC above. The page reads it with the `bot.usage` JSON-RPC method on
// this relay socket, authenticated by the same grok.com session cookies.
pub(super) const BOT_RELAY_URL: &str = "wss://grok.com/ws/bot/";
pub(super) const BOT_USAGE_REQUEST_ID: &str = "1";
pub(super) const BOT_USAGE_TIMEOUT: Duration = Duration::from_secs(8);
pub(super) const BOT_MAX_FRAMES: usize = 64;
pub(super) const BOT_MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// Id of the Grok Bot usage window; the frontend spells it the same (`usage-sources.ts`).
pub(crate) const GROK_BOT_WINDOW_ID: &str = "grok_bot";

pub(super) fn bot_usage_window(bot: &BotUsage) -> UsageWindow {
    let window_seconds = match (bot.period_start, bot.resets_at) {
        (Some(start), Some(end))
            if (5 * 86_400..=9 * 86_400).contains(&(end - start).num_seconds()) =>
        {
            (end - start).num_seconds() as u64
        }
        _ => crate::model::WEEKLY_WINDOW_SECONDS,
    };
    UsageWindow {
        id: GROK_BOT_WINDOW_ID.into(),
        // "<name> weekly" renders as its own "Grok Bot" group in the dashboard.
        label: "Grok Bot weekly".into(),
        used_percent: Some(bot.used_percent),
        remaining_percent: Some((100.0 - bot.used_percent).max(0.0)),
        resets_at: bot.resets_at.map(|value| value.to_rfc3339()),
        window_seconds: Some(window_seconds),
        kind: None,
    }
}

/// Grok Bot weekly limit, read from the `bot.usage` relay method.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct BotUsage {
    pub(super) used_percent: f64,
    pub(super) period_start: Option<DateTime<Utc>>,
    pub(super) resets_at: Option<DateTime<Utc>>,
}

#[derive(Debug, PartialEq)]
pub(super) enum BotFrame {
    /// The relay accepted the hello; requests may be sent now.
    HelloAck,
    /// Server keep-alive; the relay drops clients that do not answer.
    Ping(Option<i64>),
    /// The reply to our `bot.usage` request. `None` means an error reply or a
    /// result showing the account has no Grok Bot limit.
    Usage(Option<BotUsage>),
    Ignored,
}

pub(super) fn bot_hello_frame() -> String {
    json!({ "protocol_version": "1.0.0", "kind": "bot_client" }).to_string()
}

pub(super) fn bot_usage_request_frame() -> String {
    json!({
        "jsonrpc": "2.0",
        "id": BOT_USAGE_REQUEST_ID,
        "method": "bot.usage",
        "params": {}
    })
    .to_string()
}

pub(super) fn bot_pong_frame(ts_ms: Option<i64>) -> String {
    json!({ "method": "pong", "ts_ms": ts_ms.unwrap_or_else(|| Utc::now().timestamp_millis()) })
        .to_string()
}

pub(super) fn classify_bot_frame(text: &str) -> BotFrame {
    let Ok(Value::Object(frame)) = serde_json::from_str::<Value>(text) else {
        return BotFrame::Ignored;
    };
    if frame.contains_key("connection_id") {
        return BotFrame::HelloAck;
    }
    if let Some(method) = frame.get("method") {
        return if method.as_str() == Some("ping") {
            BotFrame::Ping(frame.get("ts_ms").and_then(Value::as_i64))
        } else {
            BotFrame::Ignored
        };
    }
    let is_our_reply = match frame.get("id") {
        Some(Value::String(id)) => id == BOT_USAGE_REQUEST_ID,
        Some(Value::Number(id)) => id.to_string() == BOT_USAGE_REQUEST_ID,
        _ => false,
    };
    if !is_our_reply {
        return BotFrame::Ignored;
    }
    if frame.contains_key("error") {
        return BotFrame::Usage(None);
    }
    BotFrame::Usage(frame.get("result").and_then(parse_bot_usage))
}

/// Mirrors how grok.com decides whether to show the Grok Bot card: no card when
/// the plan has no included Grok Bot limit and nothing has been used.
pub(super) fn parse_bot_usage(result: &Value) -> Option<BotUsage> {
    let period_start_ms = result.get("currentPeriodStartMs")?.as_f64()?;
    let percent = result
        .get("usagePercent")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite());
    let has_limit = result
        .get("hasNonZeroIncludedLimit")
        .and_then(Value::as_bool);
    let excluded = result.get("includedLimitZero").and_then(Value::as_bool) == Some(true)
        || has_limit == Some(false);
    if excluded && percent.is_none_or(|value| value <= 0.0) {
        return None;
    }
    if percent.is_none() && has_limit != Some(true) {
        return None;
    }
    Some(BotUsage {
        used_percent: percent.unwrap_or(0.0).clamp(0.0, 100.0),
        period_start: datetime_from_epoch_ms(period_start_ms),
        resets_at: result
            .get("nextResetAtMs")
            .and_then(Value::as_f64)
            .and_then(datetime_from_epoch_ms),
    })
}

pub(super) fn datetime_from_epoch_ms(value: f64) -> Option<DateTime<Utc>> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    // Tolerate a seconds value, the same way the timestamps in the billing RPC are sent.
    let millis = if value < 1e12 { value * 1000.0 } else { value } as i64;
    if !(1_700_000_000_000..=4_102_444_800_000).contains(&millis) {
        return None;
    }
    Utc.timestamp_millis_opt(millis).single()
}

/// Best effort: returns `None` on any failure, including a timeout, so the
/// caller can still show the SuperGrok window. Errors are dropped rather than
/// logged because handshake failures can echo request headers.
pub(super) async fn fetch_bot_usage(cookie_header: &str) -> Option<BotUsage> {
    let cookie_header = normalize_cookie_header(cookie_header).ok()?;
    tokio::time::timeout(BOT_USAGE_TIMEOUT, read_bot_usage(&cookie_header))
        .await
        .ok()
        .flatten()
}

pub(super) async fn read_bot_usage(cookie_header: &str) -> Option<BotUsage> {
    let mut request = BOT_RELAY_URL.into_client_request().ok()?;
    let headers = request.headers_mut();
    headers.insert(
        ws_header::COOKIE,
        HeaderValue::from_str(cookie_header).ok()?,
    );
    headers.insert(
        ws_header::ORIGIN,
        HeaderValue::from_static("https://grok.com"),
    );
    headers.insert(
        ws_header::USER_AGENT,
        HeaderValue::from_static(concat!("AI-Usage-Tracker/", env!("CARGO_PKG_VERSION"))),
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(BOT_MAX_MESSAGE_BYTES))
        .max_frame_size(Some(BOT_MAX_MESSAGE_BYTES));
    let (mut socket, _) =
        tokio_tungstenite::connect_async_with_config(request, Some(config), false)
            .await
            .ok()?;
    socket.send(Message::text(bot_hello_frame())).await.ok()?;

    let mut usage = None;
    for _ in 0..BOT_MAX_FRAMES {
        let Some(Ok(message)) = socket.next().await else {
            break;
        };
        let Message::Text(text) = message else {
            continue;
        };
        match classify_bot_frame(text.as_str()) {
            BotFrame::HelloAck => {
                if socket
                    .send(Message::text(bot_usage_request_frame()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            BotFrame::Ping(ts_ms) => {
                let _ = socket.send(Message::text(bot_pong_frame(ts_ms))).await;
            }
            BotFrame::Usage(result) => {
                usage = result;
                break;
            }
            BotFrame::Ignored => {}
        }
    }
    let _ = socket.close(None).await;
    usage
}
