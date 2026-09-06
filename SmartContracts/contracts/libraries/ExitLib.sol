// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ExitLib
 * @notice Stateless library that manages RTBF exit state: timestamps and ZKP erasure proofs.
 *         Storage lives in the calling contract (AssetRegistry) via the `Store` struct.
 *         Extending: add new fields at the END of `Store` and new functions below.
 *         Existing storage slots are never shifted.
 */
library ExitLib {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    struct Store {
        mapping(address => bytes32) erasureProofs;
        mapping(address => uint256) exitTimestamps;
        // ---- append new fields below this line ----
    }

    // -------------------------------------------------------------------------
    // Mutators
    // -------------------------------------------------------------------------

    function recordTimestamp(Store storage s, address _user) internal {
        s.exitTimestamps[_user] = block.timestamp;
    }

    function recordProof(
        Store storage s,
        address _user,
        bytes32 _proofHash
    ) internal {
        s.erasureProofs[_user] = _proofHash;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function hasProof(Store storage s, address _user) internal view returns (bool) {
        return s.erasureProofs[_user] != bytes32(0);
    }

    function getProof(Store storage s, address _user) internal view returns (bytes32) {
        return s.erasureProofs[_user];
    }

    function getTimestamp(Store storage s, address _user) internal view returns (uint256) {
        return s.exitTimestamps[_user];
    }

    function getStatus(
        Store storage s,
        bool _isRegistered,
        bool _isActive,
        address _user
    ) internal view returns (
        bool exited,
        uint256 exitTimestamp,
        bool hasErasureProof
    ) {
        // NOTE: identical to "registered but never approved" — this flag alone
        // cannot distinguish the two. exitTimestamp > 0 is the only reliable
        // signal that an actual exit happened (see Frontend admin/page.tsx and
        // dashboard/page.tsx, which both check it instead of trusting `exited`).
        exited = _isRegistered && !_isActive;
        exitTimestamp = s.exitTimestamps[_user];
        hasErasureProof = s.erasureProofs[_user] != bytes32(0);
    }
}
