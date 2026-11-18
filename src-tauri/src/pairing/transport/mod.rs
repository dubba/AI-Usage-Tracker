//! The Wi-Fi pairing session over TCP: the host side (`host`), the joining side (`client`),
//! the confirmed transfer both share (`transfer`), the events they report (`events`), and
//! the host's LAN address (`lan`). Wire constants and frame I/O live in `protocol.rs`.

mod client;
mod events;
mod host;
pub(crate) mod lan;
mod qr;
mod transfer;

pub use client::{run_client_connector, RoleChannels};
pub use events::{ClientEvent, HostEvent};
pub use host::{run_host_listener, HostSession};
pub use lan::get_local_lan_ip;
pub use qr::generate_qr_svg;

use crate::pairing::protocol::{write_frame, AbortReason, MSG_ABORT};
use std::time::Duration;
use tokio::{
    io::AsyncWrite,
    net::TcpStream,
    sync::{mpsc, oneshot},
};
use zeroize::Zeroize;

pub const SESSION_TIMEOUT_SECS: u64 = 300; // 5 minutes
pub const SOCKET_TIMEOUT_SECS: u64 = 30; // 30 seconds
/// Time allowed for the joiner's TCP connection to the host to open.
const CONNECT_TIMEOUT_SECS: u64 = 10;
/// Time allowed for the sending user to read what will be sent and confirm.
pub const CONFIRM_TIMEOUT_SECS: u64 = 60; // 60 seconds
/// Wrong link codes a host accepts before it ends the session. Each wrong
/// code is one guess out of a million, so three keeps guessing hopeless while
/// forgiving a typo.
pub const MAX_CODE_ATTEMPTS: u8 = 3;
/// Hosts a joiner tries one typed code against. A device that only pretends
/// to be a pairing host learns whether one guess of its own was right from
/// each attempt, so the number is kept small.
pub const MAX_HOSTS_TRIED: usize = 3;
/// Shown on the host when [`MAX_CODE_ATTEMPTS`] is reached.
pub const TOO_MANY_WRONG_CODES: &str =
    "The wrong link code was entered too many times. Start again to get a new code.";
/// Shown on the joiner when no host accepted the code.
pub const WRONG_CODE: &str =
    "That link code didn't match the other device. Check the code and try again.";
/// Delay before rejecting a bad handshake, throttles brute-force/garbage
/// connections without letting them kill the pairing session.
const FAILED_HANDSHAKE_DELAY: Duration = Duration::from_millis(300);

/// Tells the peer why this side is ending the connection. Best effort: the
/// peer may already be gone.
async fn send_abort<W: AsyncWrite + Unpin>(writer: &mut W, reason: AbortReason) {
    let _ = write_frame(writer, MSG_ABORT, &reason.payload()).await;
}

/// A connection whose peer proved it knows the link code. `encryption_key`
/// is shared with that peer only.
pub struct AuthenticatedPeer {
    stream: TcpStream,
    encryption_key: [u8; 32],
    transcript: Vec<u8>,
}

impl Drop for AuthenticatedPeer {
    fn drop(&mut self) {
        self.encryption_key.zeroize();
    }
}

/// The channels between one running session and the rest of the app, the same
/// for both devices.
pub struct SessionChannels<E> {
    /// Progress for the UI.
    pub status_tx: mpsc::Sender<E>,
    /// Where the user's answer to "send these accounts?" should go. It is handed
    /// to the pairing manager only once that step is reached, so an earlier
    /// answer has nothing to send on. Tests pass `None` and answer directly.
    pub confirm_offer: Option<oneshot::Sender<bool>>,
    pub confirm_rx: oneshot::Receiver<bool>,
    pub cancel_rx: oneshot::Receiver<()>,
}
