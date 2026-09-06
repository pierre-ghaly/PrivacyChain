import { test, expect, type Page } from '@playwright/test';
import { installMockWallet } from './mock-wallet';

// Hardhat's deterministic default accounts (same on every fresh `npm run dev`).
const ADMIN = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // account #0 — systemAddress / ADMIN_ROLE
const NEW_USER = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'; // account #4 — left unregistered by seed.ts

async function connectWallet(page: Page) {
  await page.getByTestId('rk-connect-button').first().click();
  await page.getByText('E2E Test Wallet').click();
  await expect(page.getByTestId('rk-account-button').first()).toBeVisible({ timeout: 10_000 });
}

// Resolves the innermost container that has both the given text and the
// given button as a descendant — i.e. the "row" for a list item, regardless
// of exactly how many `<div>` levels separate the text from the button.
function rowWithButton(page: Page, text: string, buttonName: string) {
  return page
    .locator('div')
    .filter({ hasText: text })
    .filter({ has: page.getByRole('button', { name: buttonName }) })
    .last();
}

// Walks the full RTBF demonstration sequence described in the root README through the real
// UI: register (with off-chain PII) -> admin approval -> create an asset
// (with off-chain metadata) -> admin approval -> confirm L3 metadata is
// readable via the explorer -> request erasure -> confirm L2 anchors the
// erasure proof automatically. Two browser contexts stand in for the two
// personas (a regular user and the admin) since each needs its own wallet.
//
// Navigation between pages uses in-app links (not page.goto()) wherever
// possible: the L2 SSE subscription lives in the root layout and survives
// client-side route changes, but a full navigation (goto/reload) tears it
// down and reconnects — real users never lose it mid-flow via a Link click,
// so the test shouldn't either.
test('register, approve, create asset, and erase — full RTBF sequence', async ({ browser }) => {
  const userContext = await browser.newContext();
  const userPage = await userContext.newPage();
  await installMockWallet(userPage, NEW_USER);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await installMockWallet(adminPage, ADMIN);

  const assetName = `E2E Asset ${Date.now()}`;
  const assetDescription = 'An e2e test asset, encrypted and stored on L3.';

  await test.step('user connects and registers with PII', async () => {
    await userPage.goto('/');
    await connectWallet(userPage);
    await expect(userPage.getByText('Welcome to Blockbase')).toBeVisible();
    await userPage.getByPlaceholder('Jane Doe').fill('E2E Test User');
    await userPage.getByPlaceholder('jane@example.com').fill('e2e@test.local');
    await userPage.getByRole('button', { name: 'Sign to Register' }).click();
    await expect(userPage.getByText(/Registration request saved on-chain/i)).toBeVisible({ timeout: 15_000 });
  });

  await test.step('admin approves the new user', async () => {
    await adminPage.goto('/admin');
    await connectWallet(adminPage);
    await rowWithButton(adminPage, NEW_USER, 'Approve User').getByRole('button', { name: 'Approve User' }).click();
    await expect(adminPage.getByText('No users awaiting compliance validation.')).toBeVisible({ timeout: 15_000 });
  });

  await test.step('user self-service creates an asset with off-chain metadata', async () => {
    // Client-side nav (My Assets -> + Request Asset) keeps the SSE connection
    // opened on page load alive, so the KEY_READY(ASSET_METADATA) that fires
    // moments after minting is actually received.
    await userPage.getByRole('link', { name: 'My Assets' }).click();
    await userPage.getByRole('link', { name: '+ Request Asset' }).click();
    await userPage.getByPlaceholder('Ex: Luxury Apartment #42').fill(assetName);
    await userPage.getByPlaceholder(/Describe the asset/).fill(assetDescription);
    await userPage.getByPlaceholder(/Real Estate, Vehicle/).fill('Test');
    await userPage.getByRole('button', { name: 'Mint Asset' }).click();
    await expect(userPage.getByText('Asset successfully minted on-chain!')).toBeVisible({ timeout: 15_000 });
    // give the L2 KEY_READY -> L3 /store round trip a moment to complete
    await userPage.waitForTimeout(3000);
  });

  await test.step('admin approves the asset', async () => {
    await adminPage.reload();
    await rowWithButton(adminPage, assetName, 'Approve Asset').getByRole('button', { name: 'Approve Asset' }).click();
    await expect(adminPage.getByText('No active RWA requests awaiting tokenization parameters.')).toBeVisible({
      timeout: 15_000,
    });
  });

  await test.step('explorer surfaces the L3-stored metadata', async () => {
    await adminPage.getByRole('link', { name: 'Explorer' }).click();
    await adminPage.getByPlaceholder(/Search global ledger/).fill(assetName);
    await rowWithButton(adminPage, assetName, 'View Details').getByRole('button', { name: 'View Details' }).click();
    await expect(adminPage.getByText(assetDescription)).toBeVisible({ timeout: 15_000 });
    await adminPage.getByRole('button', { name: /Close Explorer Panel/ }).click();
  });

  await test.step('user requests RTBF exit', async () => {
    await userPage.getByRole('link', { name: 'Settings' }).click();
    await userPage.getByPlaceholder('Confirm by typing your wallet address').fill(NEW_USER);
    await userPage.getByRole('button', { name: 'Initiate On-Chain Exit Protocol' }).click();
    await expect(userPage.getByText(/Exit requested/i)).toBeVisible({ timeout: 15_000 });
  });

  await test.step('L2 anchors the erasure proof automatically (no manual admin action needed)', async () => {
    await adminPage.getByRole('link', { name: 'Admin Panel' }).click();
    await adminPage.getByRole('button', { name: /RGPD\/RTBF Compliance Hub/ }).click();
    await expect(
      adminPage.getByText('No active account erasure requests pending anchoring protocols.'),
    ).toBeVisible({ timeout: 20_000 });
  });
});
