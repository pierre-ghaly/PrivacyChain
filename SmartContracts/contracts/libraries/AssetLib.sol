// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AssetLib
 * @notice Stateless library that defines the Asset struct, the enumerable per-user asset registry, and all CRUD operations.
 *         Storage lives in the calling contract (AssetRegistry) via the `Registry` struct, so the proxy's storage layout is controlled there.
 *         Extending: add new fields at the END of `Asset` and `Registry`, and new functions below.
 *         Existing storage slots are never shifted.
 */
library AssetLib {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum Status { PENDING, ACTIVE }
    enum DispositionType { TRANSFER, BURN }

    // CREATED  = asset was minted (from = address(0))
    // TRANSFERRED = voluntary user-to-user transfer
    // DISPOSED = exit-driven transfer to system/beneficiary — Kr IS derived, same as TRANSFERRED (see AssetRegistry._processExit)
    // BURNED   = exit-driven burn (no Kr derived)
    enum EventType { CREATED, TRANSFERRED, DISPOSED, BURNED }

    struct OwnershipEvent {
        address from;
        address to;
        uint256 transactionId; // type(uint256).max only for BURNED (no new owner, no Kr derived); DISPOSED (transfer-type) and TRANSFERRED both carry a real txId
        uint256 timestamp;
        EventType eventType;
    }

    struct Asset {
        uint256 id;
        string name;       // pseudonymous on-chain label (human-readable name lives in L3)
        Status status;
        uint256 createdAt;
        bool exists;
    }

    /**
     * @notice On-chain valuation record.  Certifier is the issuing authority (appraiser, bank, oracle).
     *         Value is stored in the smallest currency unit (e.g., USD cents, EUR cents).
     *         These are public records — sensitive appraisal documents belong in L3 ASSET_METADATA.
     */
    struct Valuation {
        address certifier;   // issuing authority (human-entered address or oracle contract)
        uint256 value;       // asset value in smallest currency unit
        bytes3 currencyCode; // ISO 4217 code (e.g., "USD", "EUR", "GBP")
        uint256 certifiedAt; // block.timestamp when the valuation was recorded
    }

    /**
     * @notice Bundles all asset-related storage into a single struct.
     *         The consuming contract declares one `Registry` state variable.
     */
    struct Registry {
        mapping(uint256 => Asset) assets;
        mapping(uint256 => address) assetToOwner;
        mapping(address => uint256) ownerAssetCount;
        /// Enumerable set of asset IDs per user (swap-and-pop for O(1) removal)
        mapping(address => uint256[]) userAssetIds;
        mapping(uint256 => uint256) assetIdToIndex;
        uint256 nextAssetId;
        // ---- append new fields below this line ----
        mapping(uint256 => OwnershipEvent[]) ownershipHistory;
        mapping(uint256 => Valuation[]) assetValuations;
    }

    // -------------------------------------------------------------------------
    // Mutators
    // -------------------------------------------------------------------------

    function create(
        Registry storage r,
        string memory _name,
        address _owner,
        uint256 _txId
    ) internal returns (uint256 assetId) {
        assetId = r.nextAssetId++;
        r.assets[assetId] = Asset({
            id: assetId,
            name: _name,
            status: Status.PENDING,
            createdAt: block.timestamp,
            exists: true
        });
        r.assetToOwner[assetId] = _owner;
        r.ownerAssetCount[_owner]++;
        _addToUser(r, _owner, assetId);
        r.ownershipHistory[assetId].push(OwnershipEvent({
            from: address(0),
            to: _owner,
            transactionId: _txId,
            timestamp: block.timestamp,
            eventType: EventType.CREATED
        }));
    }

    function approve(Registry storage r, uint256 _assetId) internal {
        r.assets[_assetId].status = Status.ACTIVE;
    }

    function transfer(
        Registry storage r,
        uint256 _assetId,
        address _from,
        address _to,
        uint256 _txId,
        EventType _eventType
    ) internal {
        r.assetToOwner[_assetId] = _to;
        r.ownerAssetCount[_from]--;
        r.ownerAssetCount[_to]++;
        _removeFromUser(r, _from, _assetId);
        _addToUser(r, _to, _assetId);
        r.ownershipHistory[_assetId].push(OwnershipEvent({
            from: _from,
            to: _to,
            transactionId: _txId,
            timestamp: block.timestamp,
            eventType: _eventType
        }));
    }

    function burn(
        Registry storage r,
        uint256 _assetId,
        address _owner,
        uint256 _txId
    ) internal {
        r.assets[_assetId].exists = false;
        r.assetToOwner[_assetId] = address(0);
        r.ownerAssetCount[_owner]--;
        _removeFromUser(r, _owner, _assetId);
        r.ownershipHistory[_assetId].push(OwnershipEvent({
            from: _owner,
            to: address(0),
            transactionId: _txId,
            timestamp: block.timestamp,
            eventType: EventType.BURNED
        }));
    }

    function addValuation(
        Registry storage r,
        uint256 _assetId,
        address _certifier,
        uint256 _value,
        bytes3 _currencyCode
    ) internal {
        r.assetValuations[_assetId].push(Valuation({
            certifier: _certifier,
            value: _value,
            currencyCode: _currencyCode,
            certifiedAt: block.timestamp
        }));
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function exists(Registry storage r, uint256 _assetId) internal view returns (bool) {
        return r.assets[_assetId].exists;
    }

    function getUserAssets(
        Registry storage r,
        address _user
    ) internal view returns (uint256[] memory) {
        return r.userAssetIds[_user];
    }

    function getOwnershipHistory(
        Registry storage r,
        uint256 _assetId
    ) internal view returns (OwnershipEvent[] memory) {
        return r.ownershipHistory[_assetId];
    }

    function getValuations(
        Registry storage r,
        uint256 _assetId
    ) internal view returns (Valuation[] memory) {
        return r.assetValuations[_assetId];
    }

    // -------------------------------------------------------------------------
    // Private helpers  (swap-and-pop for O(1) add/remove)
    // -------------------------------------------------------------------------

    function _addToUser(Registry storage r, address _user, uint256 _assetId) private {
        r.assetIdToIndex[_assetId] = r.userAssetIds[_user].length;
        r.userAssetIds[_user].push(_assetId);
    }

    function _removeFromUser(Registry storage r, address _user, uint256 _assetId) private {
        uint256[] storage ids = r.userAssetIds[_user];
        uint256 index = r.assetIdToIndex[_assetId];
        uint256 lastId = ids[ids.length - 1];

        ids[index] = lastId;
        r.assetIdToIndex[lastId] = index;
        ids.pop();
        delete r.assetIdToIndex[_assetId];
    }
}
