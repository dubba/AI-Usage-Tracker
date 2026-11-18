//! Progress each side reports to the pairing manager.

use crate::pairing::payload::SyncSummary;

#[derive(Debug, Clone)]
pub enum HostEvent {
    PeerConnected,
    ConfirmTransfer {
        role: String, // "sender" | "receiver"
        account_count: usize,
    },
    Transferring,
    Completed(SyncSummary),
    Cancelled,
    Expired,
    Failed(String),
}

#[derive(Debug, Clone)]
pub enum ClientEvent {
    RoleSelection,
    ConfirmTransfer {
        role: String, // "sender" | "receiver"
        account_count: usize,
    },
    Transferring,
    Completed(SyncSummary),
    Cancelled,
    Failed(String),
}

pub enum TransferEvent {
    Transferring,
    Completed(SyncSummary),
    Failed(String),
}

impl From<TransferEvent> for HostEvent {
    fn from(ev: TransferEvent) -> Self {
        match ev {
            TransferEvent::Transferring => HostEvent::Transferring,
            TransferEvent::Completed(s) => HostEvent::Completed(s),
            TransferEvent::Failed(e) => HostEvent::Failed(e),
        }
    }
}

impl From<TransferEvent> for ClientEvent {
    fn from(ev: TransferEvent) -> Self {
        match ev {
            TransferEvent::Transferring => ClientEvent::Transferring,
            TransferEvent::Completed(s) => ClientEvent::Completed(s),
            TransferEvent::Failed(e) => ClientEvent::Failed(e),
        }
    }
}
