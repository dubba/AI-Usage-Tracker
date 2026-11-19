//! How an account's plan is shown ("Max/$100", "SuperGrok/$30"), from the raw plan its provider
//! reported. The raw `plan` stays as it was; the name shown is sent with the account as
//! `planDisplay` (`Account`'s `Serialize` in `model.rs`).
//!
//! Reference prices (Free | Budget $5-10 | Standard $20-30 | Mid $100 | Max $200-300):
//! - OpenCode: Free | Go $10 | Zen PAYG | Black Tier
//! - OpenAI: Free | Go $8 | Plus $20 | Pro $100 | Pro $200
//! - Anthropic: Free | Pro $20 | Max $100 | Max $200
//! - Google: Free | Plus $5 (4.99 rounded) | Pro $20 (19.99 rounded) | Ultra $100 | Ultra $200
//! - xAI: Free | SuperGrok $30 | SuperGrok $100 | Heavy $300

use crate::model::{Account, Provider};

/// What a ChatGPT account's stored plan says about its limits. A free plan has one 30-day limit;
/// a paid one has 5-hour and weekly limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatgptPlan {
    /// The plan names a free tier ("free", "Free", "free_workspace").
    Free,
    /// Any other plan.
    Paid,
    /// No plan stored yet (a new account, or one saved before plans were read). Rules decide for
    /// themselves what to assume.
    Unknown,
}

/// The one rule for whether a ChatGPT account is on a free plan, used by the sidebar's long-meter
/// label (`headline.rs`) and the 30-day alerts (`alerts.rs`). `None` for another provider.
pub fn chatgpt_plan(account: &Account) -> Option<ChatgptPlan> {
    if account.provider != Provider::Openai {
        return None;
    }
    Some(match account.plan.as_deref().map(str::trim) {
        None | Some("") => ChatgptPlan::Unknown,
        Some(plan) if plan.to_lowercase().contains("free") => ChatgptPlan::Free,
        Some(_) => ChatgptPlan::Paid,
    })
}

/// A raw plan in the forms the rules read.
struct PlanText<'a> {
    /// Lower case.
    lower: String,
    /// Without a trailing "-tier", original case.
    without_tier: &'a str,
    /// Lower case, without a trailing "-tier".
    stripped: String,
}

impl PlanText<'_> {
    /// True when the plan contains any of the words.
    fn mentions(&self, words: &[&str]) -> bool {
        words.iter().any(|word| self.lower.contains(word))
    }

    fn is_free(&self) -> bool {
        self.stripped == "free" || self.lower == "free" || self.lower == "free-tier"
    }

    fn ultra(&self) -> String {
        if self.mentions(&["200", "30tb", "genie"]) {
            "Ultra/$200".into()
        } else {
            "Ultra/$100".into()
        }
    }

    /// The plan in capitals, or `default` when nothing is left once "-tier" is removed.
    fn upper_or(&self, default: &str) -> String {
        if self.without_tier.is_empty() {
            default.into()
        } else {
            self.without_tier.to_uppercase()
        }
    }
}

/// The name shown for `plan`, or `None` to show no plan. For each provider the first rule that
/// fits decides (so "ultra plus" is Ultra), then a fallback for plans no rule knows.
pub fn plan_display(provider: &Provider, plan: Option<&str>) -> Option<String> {
    let raw = plan.map(str::trim).filter(|plan| !plan.is_empty())?;
    let without_tier = strip_tier(raw).trim();
    let plan = PlanText {
        lower: raw.to_lowercase(),
        without_tier,
        stripped: without_tier.to_lowercase(),
    };
    let text = |name: &str| Some(name.to_string());
    match provider {
        Provider::Openai => {
            if plan.mentions(&["free"]) {
                text("Free")
            } else if plan.lower == "go" || plan.lower.contains("go/") || plan.stripped == "go" {
                text("Go/$8")
            } else if plan.mentions(&["plus"]) {
                text("Plus/$20")
            } else if plan.mentions(&["pro"]) {
                text(if plan.mentions(&["100"]) {
                    "Pro/$100"
                } else {
                    "Pro/$200"
                })
            } else if plan.mentions(&["team"]) {
                text("Team")
            } else {
                Some(plan.upper_or("Free"))
            }
        }
        Provider::Anthropic => {
            if plan.mentions(&["free"]) {
                text("Free")
            } else if plan.mentions(&["max"]) {
                text(if plan.mentions(&["200", "20x"]) {
                    "Max/$200"
                } else {
                    "Max/$100"
                })
            } else if plan.mentions(&["enterprise"]) {
                text("Enterprise")
            } else if plan.mentions(&["team"]) {
                text("Team")
            } else if plan.mentions(&["pro"]) {
                text("Pro/$20")
            } else {
                // Unrecognized values (the legacy "Claude subscription", generic rate-limit tiers)
                // say nothing about the plan, so show none until a refresh stores a real one.
                None
            }
        }
        Provider::Antigravity => {
            if plan.lower == "google antigravity" || plan.lower == "antigravity" {
                text("ANTIGRAVITY")
            } else if plan.is_free() {
                text("Free")
            } else if plan.mentions(&["ultra"]) {
                Some(plan.ultra())
            } else if plan.mentions(&["plus"]) {
                text("Plus/$5")
            } else if plan.mentions(&["pro"]) {
                text("Pro/$20")
            } else {
                let cleaned = plan.without_tier.replace('_', " ");
                let cleaned = cleaned.trim();
                if cleaned.to_lowercase().starts_with("g1-") {
                    text("Pro/$20")
                } else if cleaned.is_empty() {
                    text("Free")
                } else {
                    Some(cleaned.to_uppercase())
                }
            }
        }
        Provider::GoogleAiStudio => {
            if plan.lower.contains("free") || plan.lower == "google ai studio" {
                text("Free")
            } else if plan.mentions(&["ultra"]) {
                Some(plan.ultra())
            } else if plan.mentions(&["plus"]) {
                text("Plus/$5")
            } else if plan.mentions(&["pro"]) {
                text("Pro/$20")
            } else {
                Some(plan.upper_or("Free"))
            }
        }
        Provider::Grok => {
            if plan.mentions(&["free"]) {
                text("Free")
            } else if plan.mentions(&["heavy"]) {
                text("SuperGrok Heavy/$300")
            } else if plan.mentions(&["100", "plus"]) {
                text("SuperGrok Plus/$100")
            } else {
                text("SuperGrok/$30")
            }
        }
        Provider::OpencodeGo => {
            if plan.mentions(&["free"]) {
                text("Free")
            } else if plan.mentions(&["go"]) {
                text("Go/$10")
            } else if plan.mentions(&["zen"]) {
                text("Zen/PAYG")
            } else if plan.mentions(&["black"]) {
                text("Black Tier")
            } else {
                Some(plan.upper_or("Go/$10"))
            }
        }
    }
}

/// `plan` without one trailing "-tier" in any case.
fn strip_tier(plan: &str) -> &str {
    const SUFFIX: &str = "-tier";
    let split = plan.len().saturating_sub(SUFFIX.len());
    match (plan.get(..split), plan.get(split..)) {
        (Some(rest), Some(suffix)) if suffix.eq_ignore_ascii_case(SUFFIX) => rest,
        _ => plan,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::str::FromStr;

    const FIXTURE: &str = include_str!("plan_names.json");

    /// The frontend shows `planDisplay` as it is. The cases passed against the TypeScript rules
    /// this replaced before they were deleted.
    #[test]
    fn plan_names_match_the_shared_fixture() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 70);
        for case in cases {
            let provider = Provider::from_str(case["provider"].as_str().unwrap()).unwrap();
            let plan = case["plan"].as_str();
            assert_eq!(
                plan_display(&provider, plan).as_deref(),
                case["display"].as_str(),
                "{provider:?} {plan:?}"
            );
        }
    }

    #[test]
    fn tier_is_removed_once_and_only_at_the_end() {
        assert_eq!(strip_tier("free-tier"), "free");
        assert_eq!(strip_tier("Pro-TIER"), "Pro");
        assert_eq!(strip_tier("tier-pro"), "tier-pro");
        assert_eq!(strip_tier("x-tier-tier"), "x-tier");
        assert_eq!(strip_tier("ü-tier"), "ü");
        assert_eq!(strip_tier("tier"), "tier");
    }
}
