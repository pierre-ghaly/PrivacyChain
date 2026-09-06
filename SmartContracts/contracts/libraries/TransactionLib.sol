// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TransactionLib
 * @notice Stateless library that assigns auto-incrementing transaction IDs and tracks which transactions involve each user address.
 *         Every state-changing operation in the framework (registration, asset creation, transfer) produces a unique transaction ID.
 *         Layer 2 (off-chain key management) listens for these IDs and derives a per-transaction reference key: Kr = HKDF(salt, transactionId || nonce).
 *         On RTBF exit, the contract emits all of a user's transaction IDs so Layer 2 can destroy the corresponding Kr keys, rendering the encrypted data in Layer 3 permanently inaccessible.
 *         Storage lives in the calling contract via the `Store` struct.
 *         Extending: add new fields at the END of `Store`.
 *         Existing storage slots are never shifted.
 */
library TransactionLib {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    struct Store {
        uint256 nextTransactionId;
        mapping(address => uint256[]) userTransactionIds;
        // ---- append new fields below this line ----
    }

    // -------------------------------------------------------------------------
    // Mutators
    // -------------------------------------------------------------------------

    /**
     * @notice Record a transaction for a single user (registration, asset creation).
     * @return txId The newly assigned transaction ID.
     */
    function record(Store storage s, address _user) internal returns (uint256 txId) {
        txId = s.nextTransactionId++;
        s.userTransactionIds[_user].push(txId);
    }

    /**
     * @notice Record a transaction involving two parties (asset transfer).
     *         The same txId is added to both users' lists so that if either
     *         party exits, Layer 2 can locate and destroy the corresponding Kr.
     * @return txId The newly assigned transaction ID.
     */
    function recordForBothParties(
        Store storage s,
        address _a,
        address _b
    ) internal returns (uint256 txId) {
        txId = s.nextTransactionId++;
        s.userTransactionIds[_a].push(txId);
        s.userTransactionIds[_b].push(txId);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getUserTransactions(
        Store storage s,
        address _user
    ) internal view returns (uint256[] memory) {
        return s.userTransactionIds[_user];
    }
}
