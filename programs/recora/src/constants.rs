use anchor_lang::prelude::*;

pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_TREASURY: &[u8] = b"treasury";
pub const SEED_MERCHANT: &[u8] = b"merchant";
pub const SEED_PLAN: &[u8] = b"plan";
pub const SEED_SUB: &[u8] = b"sub";
pub const SEED_VAULT: &[u8] = b"vault";
pub const SEED_DELEGATE: &[u8] = b"delegate";
pub const SEED_CHARGE: &[u8] = b"charge";

/// Upper bound for every time window (interval, review, dispute): ten years.
/// Keeps every window well inside i64 so the timestamp maths cannot wrap.
pub const MAX_WINDOW_SECS: u64 = 10 * 365 * 24 * 60 * 60;
