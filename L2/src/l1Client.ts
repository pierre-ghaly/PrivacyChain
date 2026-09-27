import { ethers } from 'ethers';
import * as fs from 'fs';
import { config } from './config';

function loadDeployment(): { address: string; abi: ethers.InterfaceAbi } {
  const raw = fs.readFileSync(config.deploymentFile, 'utf8');
  return JSON.parse(raw).contracts.AssetRegistry;
}

function httpUrl(): string {
  return config.l1WsUrl.replace(/^ws(s)?:\/\//, 'http$1://');
}

let _contract: ethers.Contract | null = null;

function getContract(): ethers.Contract {
  if (!_contract) {
    const { address, abi } = loadDeployment();
    const provider = new ethers.JsonRpcProvider(httpUrl());
    _contract = new ethers.Contract(address, abi, provider);
  }
  return _contract;
}

const ADMIN_ROLE_HASH = ethers.keccak256(ethers.toUtf8Bytes('ADMIN_ROLE'));

export async function isAdminL1(address: string): Promise<boolean> {
  const contract = getContract();
  return (contract as any).hasRole(ADMIN_ROLE_HASH, address);
}

export interface L1AssetDetail {
  id: bigint;
  name: string;
  status: number;         // 0 = PENDING, 1 = ACTIVE, 2 = REJECTED
  createdAt: bigint;
  exists: boolean;
  owner: string;
  isPublic: boolean;
}

function decodeAssetDetail(raw: any): L1AssetDetail {
  return {
    id:        raw.id,
    name:      raw.name,
    status:    Number(raw.status),
    createdAt: raw.createdAt,
    exists:    raw.exists,
    owner:     raw.owner,
    isPublic:  raw.isPublic,
  };
}

export async function getAssetDetailL1(assetId: string): Promise<L1AssetDetail> {
  const contract = getContract();
  const raw = await (contract as any).getAssetDetail(BigInt(assetId));
  return decodeAssetDetail(raw);
}

export async function getAllAssetsDetailL1(): Promise<L1AssetDetail[]> {
  const contract = getContract();
  const raw: any[] = await (contract as any).getAllAssetsDetail();
  return raw.map(decodeAssetDetail);
}

// Whether a specific asset should be visible to a caller with no owner/admin
// relationship to it — the contract's own AND-logic check (asset.isPublic &&
// owner's per-user assetsPublic flag), mode-gated on explorerAccessMode.
// Needed because userConfigs is a private mapping on-chain (no auto-generated
// getter), so this is the only way an off-chain caller can evaluate it.
export async function isAssetPubliclyVisibleL1(assetId: string): Promise<boolean> {
  const contract = getContract();
  return (contract as any).isAssetPubliclyVisible(BigInt(assetId));
}
