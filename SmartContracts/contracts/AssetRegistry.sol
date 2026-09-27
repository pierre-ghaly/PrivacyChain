// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {UserConfigLib} from "./libraries/UserConfigLib.sol";
import {AssetLib} from "./libraries/AssetLib.sol";
import {ExitLib} from "./libraries/ExitLib.sol";
import {TransactionLib} from "./libraries/TransactionLib.sol";
import {FinancialAssertionLib} from "./libraries/FinancialAssertionLib.sol";

/**
 * @title AssetRegistry
 * @notice Layer 1 smart contract for the Privacy-Preserving Right to Be Forgotten (RTBF) framework described in the accompanying research.
 *
 * ## Triple-Layer Architecture
 *
 *   L1 (this contract) ─── on-chain state & events
 *   L2 (off-chain)     ─── key management  (listens to L1 events)
 *   L3 (off-chain)     ─── encrypted data storage
 *
 * ## Key Mapping
 *
 *   Kp (public key)   = Ethereum address (`msg.sender`).  Every registered address acts as the user's public identifier.
 *
 *   Km (master key)   = The Ethereum private key that controls the address. Never touches the chain; held only by the user.
 *
 *   Ks (session key)  = Ephemeral key negotiated off-chain (L2) between two parties for a single interaction session.
 *
 *   Kr (reference key) = Per-transaction encryption key derived off-chain by L2 using HKDF: Kr = HKDF(salt, transactionId || nonce)
 *
 *   Each state-changing operation produces a unique `transactionId` emitted in events.  L2 watches for these IDs and derives a fresh Kr for every transaction, which L3 uses to encrypt the associated data.
 *
 * ## RTBF Exit Flow
 *
 *   1. User calls `requestExit()` (or admin calls `adminProcessExit()`).
 *   2. Assets are dispositioned per the user's InactivePolicy. TRANSFER_TO_SYSTEM/TRANSFER_TO_USER derive a fresh transactionId for the new holder (same as a voluntary transfer) and L2 re-keys that asset's L3 data to them; BURN derives no transactionId and the asset's data is destroyed along with the rest.
 *   3. `KeyDestructionRequested` is emitted with all of the user's transaction IDs, plus the disposition transactionId/new-owner pairs above. L2 re-keys the disposed-but-transferred assets first, then destroys every Kr still bound to the exiting user, rendering their un-transferred encrypted data in L3 permanently inaccessible.
 *   4. L2 generates a ZKP proof of key destruction and calls `recordErasureProof()`, which stores the proof hash on-chain for audit.
 *
 * @dev UUPS-upgradeable.  Storage layout must remain append-only across versions.
 */
contract AssetRegistry is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    using UserConfigLib for UserConfigLib.Config;
    using AssetLib for AssetLib.Registry;
    using ExitLib for ExitLib.Store;
    using TransactionLib for TransactionLib.Store;
    using FinancialAssertionLib for FinancialAssertionLib.Registry;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    struct User {
        bool isRegistered;
        bool isActive;
        bool isRejected;
    }

    /// @notice Who can open the Explorer at all — a separate axis from any
    ///         individual asset's own isPublic flag (see AssetLib.Asset).
    enum ExplorerAccessMode { REGISTERED_ONLY, PUBLIC }

    struct AssetInfo {
        uint256 id;
        string name;
    }

    struct UserAssets {
        address user;
        AssetInfo[] assets;
    }

    struct OwnershipRecord {
        address from;
        address to;
        uint256 transactionId; // type(uint256).max = exit-driven burn — no new owner, no Kr derived. TRANSFER dispositions carry a real txId, same as a voluntary transfer.
        uint256 timestamp;
        AssetLib.EventType eventType;
        bool keyDestroyed; // true = L2 key is gone, L3 data permanently inaccessible
    }

    struct AssetHistory {
        uint256 assetId;
        string name;
        AssetLib.Status status;
        bool burned;
        uint256 uniqueOwnerCount; // distinct owners, excluding systemAddress
        OwnershipRecord[] chain;
    }

    /**
     * @notice Full L1 view of a single asset — all on-chain fields in one call.
     *         Combine with L2/L3 calls to assemble the complete asset object.
     */
    struct AssetDetail {
        uint256 id;
        string name;
        AssetLib.Status status;
        uint256 createdAt;
        bool exists;
        address owner;
        bool isPublic;
    }

    // --- Core state ---
    mapping(address => User) public users;
    // private, not public: getMyConfig() is the deliberate self-only read path.
    // A public mapping here would auto-generate a getter that lets anyone read
    // any address's visibility flags and exit policy directly, bypassing that.
    mapping(address => UserConfigLib.Config) private userConfigs;
    address public systemAddress;

    // --- Module storage (libraries own the structs, contract owns the slots) ---
    AssetLib.Registry private _assets;
    ExitLib.Store private _exitStore;
    TransactionLib.Store private _transactions;
    address[] private _userList;
    // ---- append new fields below this line ----
    // Forward-looking platform policy applied to *new* assets only — never
    // retroactively overrides an existing asset's own isPublic flag, which
    // stays exclusively the owner's decision (see setAssetVisibility).
    bool public platformDefaultAssetVisibility;
    ExplorerAccessMode public explorerAccessMode;
    FinancialAssertionLib.Registry private _assertions;

    // -------------------------------------------------------------------------
    // Events: Core operations
    //
    // Every event that represents a state-changing operation carries a
    // `transactionId`.  L2 uses this ID to derive a per-transaction
    // reference key Kr = HKDF(salt, transactionId || nonce).
    // -------------------------------------------------------------------------
    event UserRegistered(address indexed user, uint256 transactionId);
    event UserApproved(address indexed user, uint256 transactionId);
    event UserRejected(address indexed user, uint256 timestamp);
    event AssetCreated(uint256 indexed assetId, address indexed owner, string name, uint256 transactionId);
    event AssetApproved(uint256 indexed assetId, address indexed owner, uint256 transactionId);
    event AssetRejected(uint256 indexed assetId, address indexed owner, uint256 timestamp);
    event AssetTransferred(uint256 indexed assetId, address indexed from, address indexed to, uint256 transactionId);
    event AssetVisibilityUpdated(uint256 indexed assetId, bool isPublic);
    // Content (price/value) never appears here — see requestFinancialAssertion.
    event FinancialAssertionRequested(uint256 indexed assetId, address indexed submittedBy, address counterparty, uint256 transactionId);
    // bothConfirmed lets L2/Frontend know immediately whether this
    // confirmation was the one that unblocked admin approval, without a
    // separate read.
    event FinancialAssertionConfirmed(uint256 indexed txId, address indexed confirmedBy, bool bothConfirmed, uint256 timestamp);
    event FinancialAssertionDecided(uint256 indexed txId, bool approved, address admin, uint256 timestamp);
    event VisibilityUpdated(address indexed user, bool assetsPublic, bool transactionsPublic);
    event InactivePolicyUpdated(address indexed user, UserConfigLib.InactivePolicy policy, address beneficiary);

    // -------------------------------------------------------------------------
    // Events: RTBF / Exit  (consumed by L2 key-management and L3 storage)
    // -------------------------------------------------------------------------
    event ExitRequested(address indexed user, uint256 timestamp);
    event AssetDispositioned(uint256 indexed assetId, address indexed from, address indexed to, AssetLib.DispositionType disposition, uint256 transactionId);
    event AssetBurned(uint256 indexed assetId, address indexed owner);
    event KeyDestructionRequested(address indexed user, uint256[] assetIds, uint256[] dispositionTxIds, address[] newOwners, uint256[] transactionIds);
    event UserExitCompleted(address indexed user, uint256 timestamp);
    event UserDeactivated(address indexed user);
    event ErasureProofRecorded(address indexed user, bytes32 proofHash, uint256 timestamp);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address defaultAdmin, address _systemAddress) initializer public {
        require(_systemAddress != address(0), "System address cannot be zero");
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(ADMIN_ROLE, defaultAdmin);

        systemAddress = _systemAddress;

        users[_systemAddress] = User({isRegistered: true, isActive: true, isRejected: false});
        userConfigs[_systemAddress] = UserConfigLib.defaultConfig();

        // Explicit, not relied on as Solidity's zero-value — nothing should
        // ever be public or open by accident before an admin deliberately says so.
        platformDefaultAssetVisibility = false;
        explorerAccessMode = ExplorerAccessMode.REGISTERED_ONLY;
    }

    modifier onlyRegisteredAndActive() {
        require(users[msg.sender].isRegistered, "User not registered");
        require(users[msg.sender].isActive, "User is not active");
        _;
    }

    function registerUser() external {
        require(!users[msg.sender].isRegistered, "User already registered");
        users[msg.sender] = User({isRegistered: true, isActive: false, isRejected: false});
        userConfigs[msg.sender] = UserConfigLib.defaultConfig();
        _userList.push(msg.sender);

        uint256 txId = _transactions.record(msg.sender);
        emit UserRegistered(msg.sender, txId);
    }

    function approveUser(address _user) external onlyRole(ADMIN_ROLE) {
        require(users[_user].isRegistered, "User not registered");
        require(!users[_user].isActive, "User already active");
        require(!users[_user].isRejected, "User has been rejected");
        users[_user].isActive = true;
        uint256 txId = _transactions.record(_user);
        emit UserApproved(_user, txId);
    }

    /**
     * @notice Permanently declines a pending registration — the decision
     *         itself is on-chain (a permanent, public fact), but its
     *         consequence (destroying any keys already derived for this
     *         address, e.g. PII posted to L3 before admin ever reviewed it)
     *         happens off-chain in L2, reacting to this event — exactly how
     *         RTBF exit already works. Permanent: registerUser()'s own
     *         !isRegistered guard already blocks re-registration once
     *         rejected, so no separate re-registration guard is needed here.
     *         A re-review mechanism is explicit future work, not built now.
     */
    function rejectUser(address _user) external onlyRole(ADMIN_ROLE) {
        require(users[_user].isRegistered, "User not registered");
        require(!users[_user].isActive, "User already active");
        require(!users[_user].isRejected, "User already rejected");
        require(_exitStore.getTimestamp(_user) == 0, "User has already exited");
        users[_user].isRejected = true;
        emit UserRejected(_user, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // User configuration
    // -------------------------------------------------------------------------

    function setVisibility(bool _assetsPublic, bool _transactionsPublic) external onlyRegisteredAndActive {
        userConfigs[msg.sender].setVisibility(_assetsPublic, _transactionsPublic);
        emit VisibilityUpdated(msg.sender, _assetsPublic, _transactionsPublic);
    }

    function setInactivePolicy(
        UserConfigLib.InactivePolicy policy,
        address beneficiary
    ) external onlyRegisteredAndActive {
        if (policy == UserConfigLib.InactivePolicy.TRANSFER_TO_USER) {
            require(users[beneficiary].isRegistered, "Beneficiary must be a registered user");
            require(users[beneficiary].isActive, "Beneficiary must be active");
        }
        userConfigs[msg.sender].setInactivePolicy(policy, beneficiary);
        emit InactivePolicyUpdated(msg.sender, policy, beneficiary);
    }

    function getMyConfig() external view onlyRegisteredAndActive returns (UserConfigLib.Config memory) {
        return userConfigs[msg.sender];
    }

    // -------------------------------------------------------------------------
    // Asset management
    // -------------------------------------------------------------------------

    function createAsset(string memory _name) external onlyRegisteredAndActive returns (uint256) {
        uint256 txId = _transactions.record(msg.sender);
        uint256 assetId = _assets.create(_name, msg.sender, txId, platformDefaultAssetVisibility);
        emit AssetCreated(assetId, msg.sender, _name, txId);
        return assetId;
    }

    function approveAsset(uint256 _assetId) external onlyRole(ADMIN_ROLE) {
        require(_assets.exists(_assetId), "Asset does not exist");
        require(_assets.assets[_assetId].status == AssetLib.Status.PENDING, "Asset is not pending");
        _assets.approve(_assetId);
        address owner = _assets.assetToOwner[_assetId];
        uint256 txId = _transactions.record(owner);
        emit AssetApproved(_assetId, owner, txId);
    }

    /**
     * @notice Permanently declines a pending asset — same "decision on-chain,
     *         consequence (key destruction) reacted to off-chain in L2"
     *         pattern as rejectUser. Already-permanent for free: approveAsset
     *         and transferAsset both already require status == PENDING/ACTIVE,
     *         which a REJECTED status fails on its own — no extra guard needed
     *         beyond the one below to stop a second rejectAsset() call.
     */
    function rejectAsset(uint256 _assetId) external onlyRole(ADMIN_ROLE) {
        require(_assets.exists(_assetId), "Asset does not exist");
        require(_assets.assets[_assetId].status == AssetLib.Status.PENDING, "Asset is not pending");
        _assets.reject(_assetId);
        emit AssetRejected(_assetId, _assets.assetToOwner[_assetId], block.timestamp);
    }

    /**
     * @notice Owner-only — admin has no path to call this for someone else's
     *         asset. Once an asset exists, its visibility is exclusively the
     *         owner's decision; admin only ever influences the platform
     *         default applied to *new* assets (setDefaultAssetVisibility).
     */
    function setAssetVisibility(uint256 _assetId, bool _isPublic) external {
        require(_assets.exists(_assetId), "Asset does not exist");
        require(_assets.assetToOwner[_assetId] == msg.sender, "You do not own this asset");
        _assets.setVisibility(_assetId, _isPublic);
        emit AssetVisibilityUpdated(_assetId, _isPublic);
    }

    /**
     * @notice Forward-looking platform policy for *new* assets only — never
     *         retroactively changes any asset that already exists.
     */
    function setDefaultAssetVisibility(bool _isPublic) external onlyRole(ADMIN_ROLE) {
        platformDefaultAssetVisibility = _isPublic;
    }

    /**
     * @notice Gates whether the Explorer is reachable at all by non-admins —
     *         a different axis from any individual asset's own visibility.
     */
    function setExplorerAccessMode(ExplorerAccessMode _mode) external onlyRole(ADMIN_ROLE) {
        explorerAccessMode = _mode;
    }

    function transferAsset(uint256 _assetId, address _to) external onlyRegisteredAndActive {
        require(_assets.exists(_assetId), "Asset does not exist");
        require(_assets.assets[_assetId].status == AssetLib.Status.ACTIVE, "Asset is not active");
        require(users[_to].isRegistered, "Recipient not registered");
        require(users[_to].isActive, "Recipient is not active");
        require(_assets.assetToOwner[_assetId] == msg.sender, "You do not own this asset");

        uint256 txId = _transactions.recordForBothParties(msg.sender, _to);
        _assets.transfer(_assetId, msg.sender, _to, txId, AssetLib.EventType.TRANSFERRED);
        emit AssetTransferred(_assetId, msg.sender, _to, txId);
    }

    /**
     * @notice Mints a fresh, submitter-owned transaction ID for a financial
     *         assertion (a valuation, or — with a counterparty — a sale-price
     *         proposal) and nothing else: no price, no value, no currency,
     *         no sensitive content of any kind touches the chain here. Once
     *         this confirms, L2 derives a Kr for the new txId exactly like
     *         any other transaction, and the submitter privately POSTs the
     *         real content to L3 via the existing signed L2 gateway — the
     *         same two-step write pattern already used for registration PII
     *         and asset metadata.
     *         _counterparty = address(0) for a solo valuation; the buyer's
     *         address for a sale-price proposal (called by the seller,
     *         independently of transferAsset() — the two are not linked
     *         on-chain). Minting a *dedicated* txId here — rather than
     *         reusing transferAsset()'s own txId — is deliberate: that txId
     *         gets rekeyed to the buyer by L2 the moment a transfer happens,
     *         so the seller could never have written under it.
     */
    function requestFinancialAssertion(
        uint256 _assetId,
        address _counterparty
    ) external returns (uint256 txId) {
        require(_assets.exists(_assetId), "Asset does not exist");
        bool isOwner = users[msg.sender].isRegistered
            && users[msg.sender].isActive
            && _assets.assetToOwner[_assetId] == msg.sender;
        require(isOwner || hasRole(ADMIN_ROLE, msg.sender), "Not authorized to submit a financial assertion");
        if (_counterparty != address(0)) {
            require(_counterparty != msg.sender, "Counterparty cannot be yourself");
            require(users[_counterparty].isRegistered && users[_counterparty].isActive, "Counterparty must be a registered, active user");
        }
        txId = _transactions.record(msg.sender);
        _assertions.create(txId, msg.sender, _counterparty);
        emit FinancialAssertionRequested(_assetId, msg.sender, _counterparty, txId);
    }

    /**
     * @notice Explicit on-chain confirmation from either party to a
     *         financial assertion. For a sale-price proposal, BOTH the
     *         seller (submitter) and the buyer (counterparty) must call this
     *         before admin can approve it — submitting the proposal is not
     *         itself confirmation, so the seller confirms separately too.
     *         Deliberately symmetric: a future negotiation cycle (reject and
     *         counter-propose a different price) can reuse this same
     *         confirm-both-sides gate without special-casing the submitter.
     *         A solo valuation (no counterparty) never requires this at all
     *         — see FinancialAssertionLib.isReadyForApproval.
     */
    function confirmFinancialAssertion(uint256 _txId) external {
        bool bothConfirmed = _assertions.confirm(_txId, msg.sender);
        emit FinancialAssertionConfirmed(_txId, msg.sender, bothConfirmed, block.timestamp);
    }

    /**
     * @notice Admin's governance decision on a financial assertion — on-chain
     *         for traceability, alongside every other admin approve/reject
     *         action, but carrying no sensitive content: just the fact that
     *         txId was approved or rejected, and by whom. Approving a
     *         sale-price proposal (a txId with a counterparty) requires both
     *         parties to have already confirmed via confirmFinancialAssertion
     *         — rejecting never requires this, since declining doesn't need
     *         anyone's consent.
     */
    function decideFinancialAssertion(uint256 _txId, bool _approved) external onlyRole(ADMIN_ROLE) {
        require(_assertions.exists(_txId), "Assertion does not exist");
        require(!_assertions.isDecided(_txId), "Assertion already decided");
        if (_approved) {
            require(_assertions.isReadyForApproval(_txId), "Both parties must confirm before approval");
        }
        _assertions.markDecided(_txId);
        emit FinancialAssertionDecided(_txId, _approved, msg.sender, block.timestamp);
    }

    /**
     * @notice Read-side helper for L2/Frontend to check confirmation state
     *         directly from L1 — who's involved and whether each side has
     *         confirmed, never the asserted value itself.
     */
    function getFinancialAssertionStatus(uint256 _txId) external view returns (
        address submittedBy,
        address counterparty,
        bool sellerConfirmed,
        bool buyerConfirmed,
        bool readyForApproval
    ) {
        FinancialAssertionLib.Assertion storage a = _assertions.assertions[_txId];
        return (a.submittedBy, a.counterparty, a.sellerConfirmed, a.buyerConfirmed, _assertions.isReadyForApproval(_txId));
    }

    // -------------------------------------------------------------------------
    // RTBF / Exit  (Paper: Algorithms 1 & 4)
    // -------------------------------------------------------------------------

    /**
     * @notice User-initiated GDPR "Right to Be Forgotten" exit request.
     *         Processes all owned assets per the caller's InactivePolicy,
     *         deactivates the account, and emits events for L2 key destruction.
     */
    function requestExit() external onlyRegisteredAndActive {
        require(msg.sender != systemAddress, "System address cannot exit");
        _processExit(msg.sender);
    }

    /**
     * @notice Admin/oracle-initiated exit for regulatory or legal compliance.
     */
    function adminProcessExit(address _user) external onlyRole(ADMIN_ROLE) {
        require(users[_user].isRegistered, "User not registered");
        require(users[_user].isActive, "User is not active");
        require(_user != systemAddress, "System address cannot exit");
        _processExit(_user);
    }

    /**
     * @notice L2 callback: record the ZKP destruction proof on-chain for audit.
     *         Called after Layer 2 destroys reference keys and generates the proof.
     * @param _proofTimestamp The exact timestamp L2 hashed into _proofHash
     *        (proofHash = SHA-256(user | sortedTxIds | _proofTimestamp)) — this
     *        is an off-chain value from before the transaction was submitted,
     *        not block.timestamp, so it must be stored/emitted explicitly or
     *        the proof can never be independently recomputed after the fact.
     */
    function recordErasureProof(address _user, bytes32 _proofHash, uint256 _proofTimestamp) external onlyRole(ADMIN_ROLE) {
        require(users[_user].isRegistered, "User not registered");
        require(!users[_user].isActive, "User must be deactivated before proof recording");
        require(!_exitStore.hasProof(_user), "Erasure proof already recorded");
        require(_proofHash != bytes32(0), "Proof hash cannot be zero");
        require(_proofTimestamp != 0, "Proof timestamp cannot be zero");

        _exitStore.recordProof(_user, _proofHash, _proofTimestamp);
        emit ErasureProofRecorded(_user, _proofHash, _proofTimestamp);
    }

    /**
     * @notice The exact timestamp component of _user's erasure proof commitment
     *         (see recordErasureProof) — needed alongside getErasureProof() and
     *         the txId list from KeyDestructionRequested to independently
     *         recompute and verify the SHA-256 commitment.
     */
    function getErasureProofTimestamp(address _user) external view returns (uint256) {
        return _exitStore.getProofTimestamp(_user);
    }

    // -------------------------------------------------------------------------
    // View functions  (backward-compatible getters + off-chain helpers)
    // -------------------------------------------------------------------------

    function assets(uint256 _id) external view returns (
        uint256 id,
        string memory name,
        AssetLib.Status status,
        uint256 createdAt,
        bool exists
    ) {
        AssetLib.Asset storage a = _assets.assets[_id];
        return (a.id, a.name, a.status, a.createdAt, a.exists);
    }

    function assetToOwner(uint256 _id) external view returns (address) {
        return _assets.assetToOwner[_id];
    }

    function ownerAssetCount(address _user) external view returns (uint256) {
        return _assets.ownerAssetCount[_user];
    }

    function nextAssetId() external view returns (uint256) {
        return _assets.nextAssetId;
    }

    function getUserAssets(address _user) external view returns (AssetInfo[] memory) {
        require(msg.sender == _user || hasRole(ADMIN_ROLE, msg.sender), "Not authorized");
        uint256[] memory ids = _assets.getUserAssets(_user);
        AssetInfo[] memory result = new AssetInfo[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            result[i] = AssetInfo({id: ids[i], name: _assets.assets[ids[i]].name});
        }
        return result;
    }

    function getAllUsers() external view onlyRole(ADMIN_ROLE) returns (address[] memory) {
        return _userList;
    }

    function getAllUsersWithAssets() external view onlyRole(ADMIN_ROLE) returns (UserAssets[] memory) {
        uint256 len = _userList.length;
        UserAssets[] memory result = new UserAssets[](len);
        for (uint256 i = 0; i < len; i++) {
            address user = _userList[i];
            uint256[] memory ids = _assets.getUserAssets(user);
            AssetInfo[] memory assetInfos = new AssetInfo[](ids.length);
            for (uint256 j = 0; j < ids.length; j++) {
                assetInfos[j] = AssetInfo({id: ids[j], name: _assets.assets[ids[j]].name});
            }
            result[i] = UserAssets({user: user, assets: assetInfos});
        }
        return result;
    }

    function getAllAssets() external view onlyRole(ADMIN_ROLE) returns (AssetInfo[] memory) {
        uint256 total = _assets.nextAssetId;
        uint256 count = 0;
        for (uint256 i = 0; i < total; i++) {
            if (_assets.assets[i].exists) count++;
        }
        AssetInfo[] memory result = new AssetInfo[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < total; i++) {
            if (_assets.assets[i].exists) result[idx++] = AssetInfo({id: i, name: _assets.assets[i].name});
        }
        return result;
    }

    /**
     * @dev Shared by every AssetDetail-returning view below, so the struct's
     *      field list lives in exactly one place.
     */
    function _toAssetDetail(uint256 _assetId) private view returns (AssetDetail memory) {
        AssetLib.Asset storage a = _assets.assets[_assetId];
        return AssetDetail({
            id:        a.id,
            name:      a.name,
            status:    a.status,
            createdAt: a.createdAt,
            exists:    a.exists,
            owner:     _assets.assetToOwner[_assetId],
            isPublic:  a.isPublic
        });
    }

    /**
     * @notice Returns AssetDetail for every non-burned asset — admin only.
     *         Used by L2's aggregation endpoint to build full asset objects in one L1 call.
     */
    function getAllAssetsDetail() external view onlyRole(ADMIN_ROLE) returns (AssetDetail[] memory) {
        uint256 total = _assets.nextAssetId;
        uint256 count = 0;
        for (uint256 i = 0; i < total; i++) {
            if (_assets.assets[i].exists) count++;
        }
        AssetDetail[] memory result = new AssetDetail[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < total; i++) {
            if (!_assets.assets[i].exists) continue;
            result[idx++] = _toAssetDetail(i);
        }
        return result;
    }

    /**
     * @notice Returns AssetDetail for every non-burned, publicly-visible
     *         asset — no role restriction, callable by anyone, including a
     *         fully disconnected caller with no wallet at all (a plain RPC
     *         read). "Publicly visible" is the AND of the asset's own
     *         isPublic flag and its current owner's per-user assetsPublic
     *         flag (see isAssetPubliclyVisible). Only meaningful when
     *         explorerAccessMode == PUBLIC — the Frontend is expected to
     *         gate the Explorer link itself on that, but this view has no
     *         way to enforce that on its own since it's a plain read.
     */
    function getPublicAssetsDetail() external view returns (AssetDetail[] memory) {
        uint256 total = _assets.nextAssetId;
        uint256 count = 0;
        for (uint256 i = 0; i < total; i++) {
            if (_assets.assets[i].exists && isAssetPubliclyVisible(i)) count++;
        }
        AssetDetail[] memory result = new AssetDetail[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < total; i++) {
            if (!_assets.assets[i].exists || !isAssetPubliclyVisible(i)) continue;
            result[idx++] = _toAssetDetail(i);
        }
        return result;
    }

    /**
     * @notice Per-asset visibility check — needed because userConfigs is
     *         private (no auto-generated getter), so L2 has no other way to
     *         evaluate the AND-logic for one specific asset without pulling
     *         the entire public list. Mode-gated: even a publicly-flagged
     *         asset isn't "publicly visible" while the Explorer itself is
     *         REGISTERED_ONLY.
     */
    function isAssetPubliclyVisible(uint256 _assetId) public view returns (bool) {
        if (explorerAccessMode != ExplorerAccessMode.PUBLIC) return false;
        if (!_assets.exists(_assetId)) return false;
        if (!_assets.assets[_assetId].isPublic) return false;
        return userConfigs[_assets.assetToOwner[_assetId]].assetsPublic;
    }

    /**
     * @notice Returns all L1 fields for a single asset in one call.
     *         Pair with L2 GET /keys/cids/:txId and L3 GET /retrieve/:cid
     *         to build the full asset object including encrypted metadata.
     */
    function getAssetDetail(uint256 _assetId) external view returns (AssetDetail memory) {
        require(_assetId < _assets.nextAssetId, "Asset does not exist");
        return _toAssetDetail(_assetId);
    }

    /**
     * @notice Returns AssetDetail for every asset currently owned by a user.
     *         Combines getUserAssets + getAssetDetail into a single call.
     */
    function getUserAssetsDetail(address _user) external view returns (AssetDetail[] memory) {
        require(msg.sender == _user || hasRole(ADMIN_ROLE, msg.sender), "Not authorized");
        uint256[] memory ids = _assets.getUserAssets(_user);
        AssetDetail[] memory result = new AssetDetail[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            result[i] = _toAssetDetail(ids[i]);
        }
        return result;
    }

    function getUserTransactions(address _user) external view returns (uint256[] memory) {
        return _transactions.getUserTransactions(_user);
    }

    function nextTransactionId() external view returns (uint256) {
        return _transactions.nextTransactionId;
    }

    function getExitStatus(address _user) external view returns (
        bool exited,
        uint256 exitTimestamp,
        bool hasErasureProof
    ) {
        return _exitStore.getStatus(users[_user].isRegistered, users[_user].isActive, _user);
    }

    function getErasureProof(address _user) external view returns (bytes32) {
        return _exitStore.getProof(_user);
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * @dev Core exit logic shared by requestExit() and adminProcessExit().
     *
     *      TRANSFER_TO_SYSTEM/TRANSFER_TO_USER dispositions record a real
     *      transaction (same TransactionLib.recordForBothParties() call a
     *      voluntary transferAsset() uses) so L2 can derive a fresh Kr for
     *      the new holder and re-key the asset's L3 data to them. BURN
     *      dispositions still use the type(uint256).max sentinel — there is
     *      no new owner, so nothing to re-key.
     *
     *      `KeyDestructionRequested` carries the user's asset IDs alongside
     *      parallel dispositionTxIds[]/newOwners[] arrays (the sentinel for
     *      BURN or assets no longer owned), plus all of the user's
     *      historical transaction IDs. This lets L2's single handler re-key
     *      every disposed-but-transferred asset first, then destroy every
     *      Kr still bound to the exiting user — avoiding any race between a
     *      separate rekey listener and the destruction step.
     */
    function _processExit(address _user) internal {
        emit ExitRequested(_user, block.timestamp);

        uint256[] memory ownedAssets = _assets.getUserAssets(_user);
        UserConfigLib.Config storage cfg = userConfigs[_user];

        uint256[] memory dispositionTxIds = new uint256[](ownedAssets.length);
        address[] memory newOwners = new address[](ownedAssets.length);

        for (uint256 i = 0; i < ownedAssets.length; i++) {
            uint256 assetId = ownedAssets[i];
            if (!_assets.exists(assetId)) {
                dispositionTxIds[i] = type(uint256).max;
                newOwners[i] = address(0);
                continue;
            }

            if (cfg.inactivePolicy == UserConfigLib.InactivePolicy.TRANSFER_TO_SYSTEM) {
                uint256 txId = _transactions.recordForBothParties(_user, systemAddress);
                _assets.transfer(assetId, _user, systemAddress, txId, AssetLib.EventType.DISPOSED);
                emit AssetDispositioned(assetId, _user, systemAddress, AssetLib.DispositionType.TRANSFER, txId);
                dispositionTxIds[i] = txId;
                newOwners[i] = systemAddress;

            } else if (cfg.inactivePolicy == UserConfigLib.InactivePolicy.TRANSFER_TO_USER) {
                address beneficiary = cfg.inactiveBeneficiary;
                require(
                    users[beneficiary].isRegistered && users[beneficiary].isActive,
                    "Beneficiary is not valid"
                );
                uint256 txId = _transactions.recordForBothParties(_user, beneficiary);
                _assets.transfer(assetId, _user, beneficiary, txId, AssetLib.EventType.DISPOSED);
                emit AssetDispositioned(assetId, _user, beneficiary, AssetLib.DispositionType.TRANSFER, txId);
                dispositionTxIds[i] = txId;
                newOwners[i] = beneficiary;

            } else {
                _assets.burn(assetId, _user, type(uint256).max);
                emit AssetBurned(assetId, _user);
                emit AssetDispositioned(assetId, _user, address(0), AssetLib.DispositionType.BURN, type(uint256).max);
                dispositionTxIds[i] = type(uint256).max;
                newOwners[i] = address(0);
            }
        }

        uint256[] memory userTxIds = _transactions.getUserTransactions(_user);
        emit KeyDestructionRequested(_user, ownedAssets, dispositionTxIds, newOwners, userTxIds);

        users[_user].isActive = false;
        _exitStore.recordTimestamp(_user);
        emit UserDeactivated(_user);
        emit UserExitCompleted(_user, block.timestamp);
    }

    /**
     * @notice Returns the full ownership chain for an asset, the count of unique
     *         non-system owners, and a per-record `keyDestroyed` flag.
     *
     *         `keyDestroyed = true` means the L2 reference key Kr that was derived
     *         from that transaction has been destroyed (RTBF exit was processed),
     *         rendering the associated L3 encrypted data permanently inaccessible.
     *         All on-chain fields (addresses, timestamps, txIds) are always visible.
     *
     *         Works for both live and burned assets.
     */
    function getAssetHistory(uint256 _assetId) external view returns (AssetHistory memory) {
        require(_assetId < _assets.nextAssetId, "Asset does not exist");

        AssetLib.Asset storage asset = _assets.assets[_assetId];
        AssetLib.OwnershipEvent[] memory history = _assets.getOwnershipHistory(_assetId);

        OwnershipRecord[] memory chain = new OwnershipRecord[](history.length);
        address[] memory seenOwners = new address[](history.length);
        uint256 uniqueCount = 0;

        for (uint256 i = 0; i < history.length; i++) {
            AssetLib.OwnershipEvent memory ev = history[i];

            bool keyDestroyed;
            if (ev.eventType == AssetLib.EventType.BURNED) {
                // No new owner exists — key is unconditionally gone.
                keyDestroyed = true;
            } else {
                // CREATED, TRANSFERRED, and DISPOSED (transfer-type) all bind
                // the resulting Kr to ev.to — that is the only address whose
                // exit can affect this record. ev.from's own later exit is
                // irrelevant once ownership (and the key) has moved on.
                keyDestroyed = _hasExited(ev.to);
            }

            chain[i] = OwnershipRecord({
                from: ev.from,
                to: ev.to,
                transactionId: ev.transactionId,
                timestamp: ev.timestamp,
                eventType: ev.eventType,
                keyDestroyed: keyDestroyed
            });

            // Count unique owners in the `to` field, excluding system and zero address
            address newOwner = ev.to;
            if (newOwner != address(0) && newOwner != systemAddress) {
                bool seen = false;
                for (uint256 j = 0; j < uniqueCount; j++) {
                    if (seenOwners[j] == newOwner) { seen = true; break; }
                }
                if (!seen) seenOwners[uniqueCount++] = newOwner;
            }
        }

        return AssetHistory({
            assetId: _assetId,
            name: asset.name,
            status: asset.status,
            burned: !asset.exists,
            uniqueOwnerCount: uniqueCount,
            chain: chain
        });
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * @dev Returns true only when an address has completed the RTBF exit flow
     *      (registered, deactivated, and an exit timestamp was recorded).
     *      Returns false for address(0) and systemAddress — neither can exit.
     */
    function _hasExited(address _addr) private view returns (bool) {
        if (_addr == address(0) || _addr == systemAddress) return false;
        return users[_addr].isRegistered
            && !users[_addr].isActive
            && _exitStore.getTimestamp(_addr) != 0;
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        onlyRole(ADMIN_ROLE)
        override
    {}
}
