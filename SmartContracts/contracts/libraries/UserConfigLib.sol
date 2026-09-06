// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title UserConfigLib
 * @notice Stateless library that defines the per-user configuration struct and all logic that operates on it.
 *         Storage lives in the calling contract (AssetRegistry), so the proxy's storage layout is never disturbed by changes here.
 *         Extending: add new fields at the END of `Config` and new functions below.
 *         Existing storage slots are never shifted.
 */
library UserConfigLib {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /**
     * @notice What happens to a user's assets when their account is deactivated.
     *
     * TRANSFER_TO_SYSTEM  – assets revert to the canonical system address (default).
     * TRANSFER_TO_USER    – assets go to a pre-designated beneficiary address.
     * BURN                – assets stay in the deactivated account and become
     *                       permanently inaccessible (effectively burned).
     */
    enum InactivePolicy { TRANSFER_TO_SYSTEM, TRANSFER_TO_USER, BURN }

    /**
     * @notice Per-user configuration.  New opt-in/out features should be appended
     *         here; never reorder or remove existing fields.
     *
     * @param assetsPublic         Off-chain services may index and display this
     *                             user's asset holdings publicly. Advisory only —
     *                             not currently read or enforced by L2, L3, or the
     *                             Frontend; nothing consumes this flag yet.
     * @param transactionsPublic   Off-chain services may display this user's
     *                             transaction history publicly. Same advisory-only
     *                             caveat as assetsPublic.
     * @param inactivePolicy       Governs asset fate on account deactivation.
     * @param inactiveBeneficiary  Target address for TRANSFER_TO_USER policy;
     *                             zero for all other policies.
     */
    struct Config {
        bool assetsPublic;
        bool transactionsPublic;
        InactivePolicy inactivePolicy;
        address inactiveBeneficiary;
        // ---- append new fields below this line ----
    }

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error BeneficiaryMustBeZeroForNonTransferPolicy();

    // -------------------------------------------------------------------------
    // Initialiser
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the default config written when a user is first registered.
     *         Assets and transactions are public; assets go to the system on deactivation.
     */
    function defaultConfig() internal pure returns (Config memory) {
        return Config({
            assetsPublic: true,
            transactionsPublic: true,
            inactivePolicy: InactivePolicy.TRANSFER_TO_SYSTEM,
            inactiveBeneficiary: address(0)
        });
    }

    // -------------------------------------------------------------------------
    // Mutators (called via `using UserConfigLib for UserConfigLib.Config`)
    // -------------------------------------------------------------------------

    /**
     * @notice Toggle the public-visibility flags for assets and transactions.
     */
    function setVisibility(
        Config storage cfg,
        bool _assetsPublic,
        bool _transactionsPublic
    ) internal {
        cfg.assetsPublic = _assetsPublic;
        cfg.transactionsPublic = _transactionsPublic;
    }

    /**
     * @notice Set what happens to assets when the account is deactivated.
     * @param policy      The chosen policy.
     * @param beneficiary Required (non-zero) for TRANSFER_TO_USER; must be zero otherwise.
     *                    Non-zero-ness for TRANSFER_TO_USER is enforced by the caller
     *                    (AssetRegistry.setInactivePolicy requires a registered+active
     *                    beneficiary, which address(0) can never be) — only the
     *                    zero-for-non-transfer direction needs checking here.
     */
    function setInactivePolicy(
        Config storage cfg,
        InactivePolicy policy,
        address beneficiary
    ) internal {
        if (policy != InactivePolicy.TRANSFER_TO_USER && beneficiary != address(0)) {
            revert BeneficiaryMustBeZeroForNonTransferPolicy();
        }
        cfg.inactivePolicy = policy;
        cfg.inactiveBeneficiary = beneficiary;
    }
}
