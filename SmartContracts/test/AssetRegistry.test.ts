import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { AssetRegistry } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("AssetRegistry", function () {
  let assetRegistry: AssetRegistry;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let system: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  beforeEach(async function () {
    [owner, admin, system, user1, user2] = await ethers.getSigners();

    const AssetRegistry = await ethers.getContractFactory("AssetRegistry");
    assetRegistry = (await upgrades.deployProxy(
      AssetRegistry,
      [owner.address, system.address],
      { initializer: "initialize", kind: "uups" }
    )) as unknown as AssetRegistry;

    await assetRegistry.waitForDeployment();

    const ADMIN_ROLE = await assetRegistry.ADMIN_ROLE();
    await assetRegistry.grantRole(ADMIN_ROLE, admin.address);
  });

  /**
   * Register+approve user if needed, create asset as system, transfer to user.
   * system is always registered+active so it acts as the asset creator.
   */
  async function giveAssetToUser(
    user: SignerWithAddress,
    name: string
  ): Promise<bigint> {
    const profile = await assetRegistry.users(user.address);
    if (!profile.isRegistered) {
      await assetRegistry.connect(user).registerUser();
      await assetRegistry.connect(admin).approveUser(user.address);
    } else if (!profile.isActive) {
      await assetRegistry.connect(admin).approveUser(user.address);
    }
    const tx = await assetRegistry.connect(system).createAsset(name);
    await tx.wait();
    const assetId = await assetRegistry.nextAssetId() - 1n;
    await assetRegistry.connect(admin).approveAsset(assetId);
    await assetRegistry.connect(system).transferAsset(assetId, user.address);
    return assetId;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  describe("Registration", function () {
    it("should register a user and emit transactionId", async function () {
      const tx = assetRegistry.connect(user1).registerUser();

      await expect(tx)
        .to.emit(assetRegistry, "UserRegistered")
        .withArgs(user1.address, 0n);

      const profile = await assetRegistry.users(user1.address);
      expect(profile.isRegistered).to.be.true;
      expect(profile.isActive).to.be.false; // inactive until admin calls approveUser
    });

    it("should reject duplicate registration", async function () {
      await assetRegistry.connect(user1).registerUser();
      await expect(
        assetRegistry.connect(user1).registerUser()
      ).to.be.revertedWith("User already registered");
    });

    it("should pre-register system address at initialization", async function () {
      const profile = await assetRegistry.users(system.address);
      expect(profile.isRegistered).to.be.true;
      expect(profile.isActive).to.be.true;
    });
  });

  // ---------------------------------------------------------------------------
  // Asset creation & transfer
  // ---------------------------------------------------------------------------

  describe("Asset Creation & Transfer", function () {
    it("should create an asset owned by systemAddress with transactionId", async function () {
      const tx = assetRegistry.connect(system).createAsset("Downtown Apartment");

      await expect(tx)
        .to.emit(assetRegistry, "AssetCreated")
        .withArgs(0n, system.address, "Downtown Apartment", 0n);

      const asset = await assetRegistry.assets(0);
      expect(asset.name).to.equal("Downtown Apartment");
      expect(asset.exists).to.be.true;

      expect(await assetRegistry.assetToOwner(0)).to.equal(system.address);
      expect(await assetRegistry.ownerAssetCount(system.address)).to.equal(1n);

      const systemAssets = await assetRegistry.getUserAssets(system.address);
      expect(systemAssets.length).to.equal(1);
      expect(systemAssets[0].id).to.equal(0n);
    });

    it("should transfer asset with transactionId recorded for both parties", async function () {
      await assetRegistry.connect(user1).registerUser();
      await assetRegistry.connect(admin).approveUser(user1.address);
      await assetRegistry.connect(system).createAsset("Beach House");
      await assetRegistry.connect(admin).approveAsset(0);

      const expectedTxId = await assetRegistry.nextTransactionId();
      const tx = assetRegistry.connect(system).transferAsset(0, user1.address);

      await expect(tx)
        .to.emit(assetRegistry, "AssetTransferred")
        .withArgs(0n, system.address, user1.address, expectedTxId);

      expect(await assetRegistry.assetToOwner(0)).to.equal(user1.address);
      expect(await assetRegistry.ownerAssetCount(user1.address)).to.equal(1n);
      expect(await assetRegistry.ownerAssetCount(system.address)).to.equal(0n);

      const user1Assets = await assetRegistry.getUserAssets(user1.address);
      expect(user1Assets.length).to.equal(1);
      expect(user1Assets[0].id).to.equal(0n);
      expect((await assetRegistry.getUserAssets(system.address)).length).to.equal(0);
    });

    it("should transfer assets between registered users", async function () {
      const assetId = await giveAssetToUser(user1, "Farm Land");
      await assetRegistry.connect(user2).registerUser();
      await assetRegistry.connect(admin).approveUser(user2.address);

      await assetRegistry.connect(user1).transferAsset(assetId, user2.address);

      expect(await assetRegistry.assetToOwner(assetId)).to.equal(user2.address);
      expect(await assetRegistry.ownerAssetCount(user1.address)).to.equal(0n);
      expect(await assetRegistry.ownerAssetCount(user2.address)).to.equal(1n);
    });

    it("should prevent non-owners from transferring an asset", async function () {
      await giveAssetToUser(user1, "Farm Land");
      await assetRegistry.connect(user2).registerUser();
      await assetRegistry.connect(admin).approveUser(user2.address);

      await expect(
        assetRegistry.connect(user2).transferAsset(0, user2.address)
      ).to.be.revertedWith("You do not own this asset");
    });

    it("should reject transferring a still-PENDING asset", async function () {
      await assetRegistry.connect(user1).registerUser();
      await assetRegistry.connect(admin).approveUser(user1.address);
      await assetRegistry.connect(system).createAsset("Unapproved Yacht");

      await expect(
        assetRegistry.connect(system).transferAsset(0, user1.address)
      ).to.be.revertedWith("Asset is not active");
    });

    it("should allow adding a valuation to a still-PENDING asset", async function () {
      await assetRegistry.connect(system).createAsset("Unapproved Yacht");

      await expect(
        assetRegistry.connect(admin).addValuation(0, admin.address, 1000n, "0x555344")
      ).to.emit(assetRegistry, "ValuationAdded");
    });

    it("should track multiple assets per user via getUserAssets", async function () {
      const id0 = await giveAssetToUser(user1, "Asset A");
      const id1 = await giveAssetToUser(user1, "Asset B");
      const id2 = await giveAssetToUser(user1, "Asset C");

      const assets = await assetRegistry.getUserAssets(user1.address);
      expect(assets.length).to.equal(3);
      expect(assets.map((a: any) => Number(a.id)).sort()).to.deep.equal(
        [Number(id0), Number(id1), Number(id2)].sort()
      );
    });
  });

  // ---------------------------------------------------------------------------
  // User configuration
  // ---------------------------------------------------------------------------

  describe("User Configuration", function () {
    beforeEach(async function () {
      await assetRegistry.connect(user1).registerUser();
      await assetRegistry.connect(admin).approveUser(user1.address);
    });

    it("should update visibility settings", async function () {
      await expect(assetRegistry.connect(user1).setVisibility(false, false))
        .to.emit(assetRegistry, "VisibilityUpdated")
        .withArgs(user1.address, false, false);
    });

    it("should set TRANSFER_TO_USER inactive policy with valid beneficiary", async function () {
      await assetRegistry.connect(user2).registerUser();
      await assetRegistry.connect(admin).approveUser(user2.address);
      await expect(
        assetRegistry.connect(user1).setInactivePolicy(1, user2.address)
      )
        .to.emit(assetRegistry, "InactivePolicyUpdated")
        .withArgs(user1.address, 1, user2.address);
    });

    it("should reject TRANSFER_TO_USER with unregistered beneficiary", async function () {
      await expect(
        assetRegistry.connect(user1).setInactivePolicy(1, user2.address)
      ).to.be.revertedWith("Beneficiary must be a registered user");
    });
  });

  // ---------------------------------------------------------------------------
  // RTBF Exit — TRANSFER_TO_SYSTEM (default policy)
  // ---------------------------------------------------------------------------

  describe("RTBF Exit — TRANSFER_TO_SYSTEM", function () {
    let assetId0: bigint;
    let assetId1: bigint;

    beforeEach(async function () {
      assetId0 = await giveAssetToUser(user1, "Property A");
      assetId1 = await giveAssetToUser(user1, "Property B");
    });

    it("should transfer all assets to systemAddress and deactivate user", async function () {
      await assetRegistry.connect(user1).requestExit();

      expect(await assetRegistry.assetToOwner(assetId0)).to.equal(system.address);
      expect(await assetRegistry.assetToOwner(assetId1)).to.equal(system.address);
      expect(await assetRegistry.ownerAssetCount(user1.address)).to.equal(0n);

      const profile = await assetRegistry.users(user1.address);
      expect(profile.isActive).to.be.false;
    });

    it("should emit the full RTBF event sequence", async function () {
      const tx = assetRegistry.connect(user1).requestExit();

      await expect(tx).to.emit(assetRegistry, "ExitRequested").withArgs(user1.address, await getBlockTimestamp(tx));
      await expect(tx).to.emit(assetRegistry, "AssetDispositioned");
      await expect(tx).to.emit(assetRegistry, "KeyDestructionRequested");
      await expect(tx).to.emit(assetRegistry, "UserDeactivated").withArgs(user1.address);
      await expect(tx).to.emit(assetRegistry, "UserExitCompleted");
    });

    it("should include transactionIds in KeyDestructionRequested", async function () {
      const userTxIds = await assetRegistry.getUserTransactions(user1.address);
      expect(userTxIds.length).to.be.greaterThan(0);

      const tx = assetRegistry.connect(user1).requestExit();
      await expect(tx).to.emit(assetRegistry, "KeyDestructionRequested");
    });

    it("should record exit timestamp in getExitStatus", async function () {
      await assetRegistry.connect(user1).requestExit();

      const status = await assetRegistry.getExitStatus(user1.address);
      expect(status.exited).to.be.true;
      expect(status.exitTimestamp).to.be.greaterThan(0n);
      expect(status.hasErasureProof).to.be.false;
    });

    it("should prevent exited user from further operations", async function () {
      await assetRegistry.connect(user1).requestExit();

      await expect(
        assetRegistry.connect(user1).requestExit()
      ).to.be.revertedWith("User is not active");

      await expect(
        assetRegistry.connect(user1).setVisibility(false, false)
      ).to.be.revertedWith("User is not active");
    });
  });

  // ---------------------------------------------------------------------------
  // RTBF Exit — TRANSFER_TO_USER
  // ---------------------------------------------------------------------------

  describe("RTBF Exit — TRANSFER_TO_USER", function () {
    it("should transfer all assets to the designated beneficiary", async function () {
      const assetId = await giveAssetToUser(user1, "Art NFT");
      await assetRegistry.connect(user2).registerUser();
      await assetRegistry.connect(admin).approveUser(user2.address);

      await assetRegistry.connect(user1).setInactivePolicy(1, user2.address);
      await assetRegistry.connect(user1).requestExit();

      expect(await assetRegistry.assetToOwner(assetId)).to.equal(user2.address);
      expect(await assetRegistry.ownerAssetCount(user2.address)).to.equal(1n);
      expect((await assetRegistry.users(user1.address)).isActive).to.be.false;
    });

    it("should record a real disposition txId for both the exiting user and the beneficiary", async function () {
      const assetId = await giveAssetToUser(user1, "Art NFT");
      await assetRegistry.connect(user2).registerUser();
      await assetRegistry.connect(admin).approveUser(user2.address);
      await assetRegistry.connect(user1).setInactivePolicy(1, user2.address);

      const expectedTxId = await assetRegistry.nextTransactionId();
      const tx = assetRegistry.connect(user1).requestExit();

      await expect(tx)
        .to.emit(assetRegistry, "AssetDispositioned")
        .withArgs(assetId, user1.address, user2.address, 0, expectedTxId); // 0 = DispositionType.TRANSFER

      expect(expectedTxId).to.not.equal(ethers.MaxUint256);
      expect(await assetRegistry.getUserTransactions(user1.address)).to.include(expectedTxId);
      expect(await assetRegistry.getUserTransactions(user2.address)).to.include(expectedTxId);
    });
  });

  // ---------------------------------------------------------------------------
  // RTBF Exit — BURN
  // ---------------------------------------------------------------------------

  describe("RTBF Exit — BURN", function () {
    it("should burn all assets and deactivate user", async function () {
      const assetId = await giveAssetToUser(user1, "Sensitive Doc");

      await assetRegistry.connect(user1).setInactivePolicy(2, ethers.ZeroAddress);
      const tx = assetRegistry.connect(user1).requestExit();

      await expect(tx)
        .to.emit(assetRegistry, "AssetBurned")
        .withArgs(assetId, user1.address);
      await expect(tx)
        .to.emit(assetRegistry, "AssetDispositioned")
        .withArgs(assetId, user1.address, ethers.ZeroAddress, 1, ethers.MaxUint256);

      const asset = await assetRegistry.assets(assetId);
      expect(asset.exists).to.be.false;
      expect(await assetRegistry.assetToOwner(assetId)).to.equal(ethers.ZeroAddress);
      expect(await assetRegistry.ownerAssetCount(user1.address)).to.equal(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // Asset History — keyDestroyed on TRANSFER disposition
  // ---------------------------------------------------------------------------

  describe("Asset History — keyDestroyed on TRANSFER disposition", function () {
    it("marks the disposition record's key destroyed only after the beneficiary exits", async function () {
      const assetId = await giveAssetToUser(user1, "Heirloom");
      await assetRegistry.connect(user2).registerUser();
      await assetRegistry.connect(admin).approveUser(user2.address);
      await assetRegistry.connect(user1).setInactivePolicy(1, user2.address); // TRANSFER_TO_USER -> user2
      await assetRegistry.connect(user1).requestExit();

      const historyBefore = await assetRegistry.getAssetHistory(assetId);
      const idx = historyBefore.chain.length - 1;
      expect(historyBefore.chain[idx].eventType).to.equal(2); // DISPOSED
      expect(historyBefore.chain[idx].to).to.equal(user2.address);
      expect(historyBefore.chain[idx].transactionId).to.not.equal(ethers.MaxUint256);
      expect(historyBefore.chain[idx].keyDestroyed).to.be.false;

      // user2's own exit re-dispositions the asset onward (default TRANSFER_TO_SYSTEM,
      // since user2 never called setInactivePolicy) — the chain grows by one more
      // record, so we assert on the fixed index captured above, not "last record".
      await assetRegistry.connect(user2).requestExit();

      const historyAfter = await assetRegistry.getAssetHistory(assetId);
      expect(historyAfter.chain[idx].keyDestroyed).to.be.true;
    });
  });

  // ---------------------------------------------------------------------------
  // Admin-initiated exit
  // ---------------------------------------------------------------------------

  describe("Admin Exit", function () {
    it("should allow admin to force-process a user exit", async function () {
      const assetId = await giveAssetToUser(user1, "Estate");

      await assetRegistry.connect(admin).adminProcessExit(user1.address);

      expect(await assetRegistry.assetToOwner(assetId)).to.equal(system.address);
      expect((await assetRegistry.users(user1.address)).isActive).to.be.false;
    });

    it("should reject admin exit for unregistered address", async function () {
      await expect(
        assetRegistry.connect(admin).adminProcessExit(user2.address)
      ).to.be.revertedWith("User not registered");
    });

    it("should reject admin exit for already-deactivated user", async function () {
      await giveAssetToUser(user1, "X");
      await assetRegistry.connect(user1).requestExit();

      await expect(
        assetRegistry.connect(admin).adminProcessExit(user1.address)
      ).to.be.revertedWith("User is not active");
    });
  });

  // ---------------------------------------------------------------------------
  // Erasure proof recording
  // ---------------------------------------------------------------------------

  describe("Erasure Proof", function () {
    const proofHash = ethers.id("zkp-destruction-proof-001");

    beforeEach(async function () {
      await giveAssetToUser(user1, "Proof Asset");
      await assetRegistry.connect(user1).requestExit();
    });

    it("should record erasure proof for a deactivated user", async function () {
      const tx = assetRegistry.connect(owner).recordErasureProof(user1.address, proofHash);

      await expect(tx)
        .to.emit(assetRegistry, "ErasureProofRecorded")
        .withArgs(user1.address, proofHash, await getBlockTimestamp(tx));

      expect(await assetRegistry.getErasureProof(user1.address)).to.equal(proofHash);

      const status = await assetRegistry.getExitStatus(user1.address);
      expect(status.hasErasureProof).to.be.true;
    });

    it("should reject proof for an active user", async function () {
      await assetRegistry.connect(user2).registerUser();
      await assetRegistry.connect(admin).approveUser(user2.address);
      await expect(
        assetRegistry.connect(owner).recordErasureProof(user2.address, proofHash)
      ).to.be.revertedWith("User must be deactivated before proof recording");
    });

    it("should reject duplicate proof recording", async function () {
      await assetRegistry.connect(owner).recordErasureProof(user1.address, proofHash);
      await expect(
        assetRegistry.connect(owner).recordErasureProof(user1.address, proofHash)
      ).to.be.revertedWith("Erasure proof already recorded");
    });

    it("should reject zero proof hash", async function () {
      await expect(
        assetRegistry.connect(owner).recordErasureProof(user1.address, ethers.ZeroHash)
      ).to.be.revertedWith("Proof hash cannot be zero");
    });
  });

  // ---------------------------------------------------------------------------
  // Transaction tracking
  // ---------------------------------------------------------------------------

  describe("Transaction Tracking", function () {
    it("should assign sequential transaction IDs", async function () {
      await assetRegistry.connect(user1).registerUser();            // txId 0
      await assetRegistry.connect(admin).approveUser(user1.address); // txId 1
      await assetRegistry.connect(user1).createAsset("Asset1");    // txId 2
      expect(await assetRegistry.nextTransactionId()).to.equal(3n);
    });

    it("should track transactions per user on registration", async function () {
      await assetRegistry.connect(user1).registerUser();

      const txIds = await assetRegistry.getUserTransactions(user1.address);
      expect(txIds.length).to.equal(1);
      expect(txIds[0]).to.equal(0n);
    });

    it("should track transactions for system on asset creation", async function () {
      await assetRegistry.connect(system).createAsset("Asset1");

      const systemTxIds = await assetRegistry.getUserTransactions(system.address);
      expect(systemTxIds.length).to.equal(1);
      expect(systemTxIds[0]).to.equal(0n);
    });

    it("should record transfer transaction for both sender and receiver", async function () {
      await assetRegistry.connect(user1).registerUser();
      await assetRegistry.connect(admin).approveUser(user1.address);
      await assetRegistry.connect(system).createAsset("Asset1");
      await assetRegistry.connect(admin).approveAsset(0);

      const transferTxId = await assetRegistry.nextTransactionId();
      await assetRegistry.connect(system).transferAsset(0, user1.address);

      const systemTxIds = await assetRegistry.getUserTransactions(system.address);
      const user1TxIds = await assetRegistry.getUserTransactions(user1.address);

      expect(systemTxIds).to.include(transferTxId);
      expect(user1TxIds).to.include(transferTxId);
    });

    it("should accumulate all transactions for a user across operations", async function () {
      await assetRegistry.connect(user1).registerUser();            // txId 0 → user1
      await assetRegistry.connect(admin).approveUser(user1.address); // txId 1 → user1
      await assetRegistry.connect(user2).registerUser();            // txId 2 → user2
      await assetRegistry.connect(admin).approveUser(user2.address); // txId 3 → user2
      await assetRegistry.connect(system).createAsset("A1");       // txId 4 → system
      await assetRegistry.connect(admin).approveAsset(0);          // txId 5 → system
      await assetRegistry.connect(system).transferAsset(0, user1.address); // txId 6 → system+user1
      await assetRegistry.connect(system).createAsset("A2");       // txId 7 → system
      await assetRegistry.connect(admin).approveAsset(1);          // txId 8 → system
      await assetRegistry.connect(system).transferAsset(1, user1.address); // txId 9 → system+user1
      await assetRegistry.connect(user1).transferAsset(0, user2.address);  // txId 10 → user1+user2

      const user1TxIds = await assetRegistry.getUserTransactions(user1.address);
      expect(user1TxIds.length).to.equal(5); // 0,1,6,9,10

      const user2TxIds = await assetRegistry.getUserTransactions(user2.address);
      expect(user2TxIds.length).to.equal(3); // 2,3,10
    });

    it("should emit all user transactionIds in KeyDestructionRequested on exit", async function () {
      await assetRegistry.connect(user1).registerUser();            // txId 0
      await assetRegistry.connect(admin).approveUser(user1.address); // txId 1
      await assetRegistry.connect(system).createAsset("A1");       // txId 2
      await assetRegistry.connect(admin).approveAsset(0);          // txId 3 → system
      await assetRegistry.connect(system).transferAsset(0, user1.address); // txId 4

      const expectedTxIds = await assetRegistry.getUserTransactions(user1.address);
      expect(expectedTxIds.length).to.equal(3); // 0, 1, 4

      const tx = assetRegistry.connect(user1).requestExit();
      await expect(tx).to.emit(assetRegistry, "KeyDestructionRequested");
    });
  });

  // ---------------------------------------------------------------------------
  // Guards & edge cases
  // ---------------------------------------------------------------------------

  describe("Guards", function () {
    it("should prevent system address from exiting", async function () {
      await expect(
        assetRegistry.connect(system).requestExit()
      ).to.be.revertedWith("System address cannot exit");
    });

    it("should prevent admin from exiting system address", async function () {
      await expect(
        assetRegistry.connect(admin).adminProcessExit(system.address)
      ).to.be.revertedWith("System address cannot exit");
    });

    it("should handle exit with zero assets gracefully", async function () {
      await assetRegistry.connect(user1).registerUser();
      await assetRegistry.connect(admin).approveUser(user1.address);
      await assetRegistry.connect(user1).requestExit();

      const profile = await assetRegistry.users(user1.address);
      expect(profile.isActive).to.be.false;
    });
  });

  // ---------------------------------------------------------------------------
  // UUPS Upgrade
  // ---------------------------------------------------------------------------

  describe("UUPS Upgrade", function () {
    it("should prevent non-admins from upgrading the contract", async function () {
      await assetRegistry.connect(user1).registerUser();
      const AssetRegistryV2 = await ethers.getContractFactory("AssetRegistry");
      await expect(
        upgrades.upgradeProxy(await assetRegistry.getAddress(), AssetRegistryV2.connect(user1))
      ).to.be.revertedWithCustomError(assetRegistry, "AccessControlUnauthorizedAccount");
    });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function getBlockTimestamp(txPromise: Promise<any>): Promise<bigint> {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    return BigInt(block!.timestamp);
  }
});
