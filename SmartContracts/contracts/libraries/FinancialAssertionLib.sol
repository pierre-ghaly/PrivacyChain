// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title FinancialAssertionLib
 * @notice Stateless library tracking, per financial-assertion transactionId,
 *         who is involved and whether each side has confirmed — never the
 *         asserted value itself (that stays off-chain in L3). Storing this
 *         much on-chain leaks nothing beyond what FinancialAssertionRequested
 *         already emits publicly; it just makes "have both parties confirmed"
 *         checkable from within AssetRegistry.decideFinancialAssertion.
 *         Extending: add new fields at the END of `Assertion`/`Registry`.
 */
library FinancialAssertionLib {

    struct Assertion {
        address submittedBy;   // the seller for a sale-price proposal
        address counterparty;  // the buyer; address(0) for a solo valuation
        bool sellerConfirmed;
        bool buyerConfirmed;
        bool exists;
        // ---- append new fields below this line ----
        bool decided; // true once admin has approved or rejected — blocks a second decision on the same txId
    }

    struct Registry {
        mapping(uint256 => Assertion) assertions;
    }

    function create(
        Registry storage r,
        uint256 _txId,
        address _submittedBy,
        address _counterparty
    ) internal {
        r.assertions[_txId] = Assertion({
            submittedBy: _submittedBy,
            counterparty: _counterparty,
            sellerConfirmed: false,
            buyerConfirmed: false,
            exists: true,
            decided: false
        });
    }

    /**
     * @notice Records msg.sender's confirmation. Reverts unless the caller is
     *         actually a party to this assertion (the submitter or its
     *         counterparty).
     * @return bothConfirmed Whether the assertion is now ready for admin
     *         approval (see isReadyForApproval) — returned here so the caller
     *         can include it in the emitted event without a second read.
     */
    function confirm(Registry storage r, uint256 _txId, address _caller) internal returns (bool bothConfirmed) {
        Assertion storage a = r.assertions[_txId];
        require(a.exists, "Assertion does not exist");
        require(_caller == a.submittedBy || _caller == a.counterparty, "Not a party to this assertion");
        if (_caller == a.submittedBy) {
            a.sellerConfirmed = true;
        } else {
            a.buyerConfirmed = true;
        }
        return _isReady(a);
    }

    function exists(Registry storage r, uint256 _txId) internal view returns (bool) {
        return r.assertions[_txId].exists;
    }

    function isDecided(Registry storage r, uint256 _txId) internal view returns (bool) {
        return r.assertions[_txId].decided;
    }

    /// @notice Marks a txId as decided — called once, from decideFinancialAssertion,
    ///         after its "not already decided" guard has already passed.
    function markDecided(Registry storage r, uint256 _txId) internal {
        r.assertions[_txId].decided = true;
    }

    /**
     * @notice A solo valuation (no counterparty) never needs a second party's
     *         confirmation — only a sale-price proposal (counterparty set)
     *         requires both sides before admin can approve.
     */
    function isReadyForApproval(Registry storage r, uint256 _txId) internal view returns (bool) {
        return _isReady(r.assertions[_txId]);
    }

    function _isReady(Assertion storage a) private view returns (bool) {
        if (a.counterparty == address(0)) return true;
        return a.sellerConfirmed && a.buyerConfirmed;
    }
}
