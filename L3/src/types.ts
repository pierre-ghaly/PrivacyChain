/**
 * Data types stored as encrypted blobs in L3 (Helia IPFS).
 * All blobs are AES-256-GCM encrypted with the asset/user's Kr derived by L2.
 * After RTBF exit L2 destroys Kr — the encrypted blobs remain on IPFS but
 * are permanently inaccessible (cryptographic erasure).
 */

/**
 * USER_PII — stored once per user registration (txId from UserRegistered event).
 * Contains the real-world identity data kept off-chain.
 */
export interface UserPii {
  realName: string;
  email: string;
  address?: string;
}

/**
 * ASSET_METADATA — stored once per asset creation (txId from AssetCreated event).
 * The on-chain Asset struct holds only a pseudonymous `name`.
 * All descriptive, financial-document, and media references live here.
 *
 * Layer mapping:
 *   L1 (public)  — id, name (pseudonym), status, timestamps, Valuation[] (certifier + value)
 *   L3 (private) — description, category, metadata key-values, image CIDs
 */
export interface AssetMetadata {
  /** Human-readable description of the asset. */
  description: string;

  /**
   * Asset category / type.
   * Examples: "Real Estate", "Vehicle", "Artwork", "Document", "Equipment"
   */
  category?: string;

  /**
   * Open-ended key-value pairs for asset-specific attributes.
   * All values are strings — parse numerics/dates client-side.
   * Examples:
   *   Real estate: { location: "123 Main St, City", size: "1200 sqft", yearBuilt: "1990", bedrooms: "3" }
   *   Vehicle:     { make: "Toyota", model: "Camry", year: "2018", mileage: "45000", vin: "..." }
   *   Artwork:     { artist: "...", medium: "Oil on canvas", dimensions: "60x80cm", year: "2005" }
   */
  metadata?: Record<string, string>;

  /**
   * IPFS CIDs of encrypted image blobs stored in L3.
   * Each CID was returned by POST /images using the same txId as this metadata.
   * Retrieve images via GET /retrieve/:cid?txId=<txId>.
   */
  imageCids?: string[];
}
