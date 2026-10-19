pub(super) fn split_version(v: &str) -> (Vec<u64>, Option<String>) {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let numeric_end = v
        .char_indices()
        .find(|(_, ch)| !ch.is_ascii_digit() && *ch != '.')
        .map(|(i, _)| i)
        .unwrap_or(v.len());
    let numeric = v[..numeric_end]
        .split('.')
        .filter_map(|part| {
            if part.is_empty() {
                None
            } else {
                part.parse::<u64>().ok()
            }
        })
        .collect();
    let pre = v[numeric_end..]
        .trim_start_matches(|ch: char| !ch.is_ascii_alphanumeric())
        .to_ascii_lowercase();
    (numeric, if pre.is_empty() { None } else { Some(pre) })
}

pub(super) fn compare_prerelease(cand: &str, curr: &str) -> bool {
    let cand_tokens: Vec<&str> = cand
        .split(['.', '-', '_'])
        .filter(|s| !s.is_empty())
        .collect();
    let curr_tokens: Vec<&str> = curr
        .split(['.', '-', '_'])
        .filter(|s| !s.is_empty())
        .collect();
    let min_len = cand_tokens.len().min(curr_tokens.len());
    for i in 0..min_len {
        let c = cand_tokens[i];
        let u = curr_tokens[i];
        if c == u {
            continue;
        }
        let c_num = c.parse::<u64>();
        let u_num = u.parse::<u64>();
        match (c_num, u_num) {
            (Ok(cn), Ok(un)) => return cn > un,
            (Ok(_), Err(_)) => return false,
            (Err(_), Ok(_)) => return true,
            (Err(_), Err(_)) => return c > u,
        }
    }
    cand_tokens.len() > curr_tokens.len()
}

pub(super) fn is_newer_version(candidate: &str, current: &str) -> bool {
    let (cand_parts, cand_pre) = split_version(candidate);
    let (curr_parts, curr_pre) = split_version(current);
    let max_len = cand_parts.len().max(curr_parts.len());
    for i in 0..max_len {
        let cand = cand_parts.get(i).copied().unwrap_or(0);
        let curr = curr_parts.get(i).copied().unwrap_or(0);
        if cand != curr {
            return cand > curr;
        }
    }
    match (cand_pre.as_deref(), curr_pre.as_deref()) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (None, None) => false,
        (Some(cand), Some(curr)) => compare_prerelease(cand, curr),
    }
}

/// The version an update notification refers to, in the form our own
/// notification sends (`0.4.1`, `0.4.2-beta.1`, optionally with a leading `v`).
/// The value arrives as an intent extra that any installed app can set, so
/// anything else is ignored rather than shown in the update dialog.
#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
pub(super) fn is_update_notice_version(value: &str) -> bool {
    let core = value.strip_prefix(['v', 'V']).unwrap_or(value);
    let (numbers, prerelease) = match core.split_once('-') {
        Some((numbers, prerelease)) => (numbers, Some(prerelease)),
        None => (core, None),
    };
    value.len() <= 32
        && numbers.split('.').count() == 3
        && numbers
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && prerelease.is_none_or(|tag| {
            !tag.is_empty()
                && tag
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
        })
}
