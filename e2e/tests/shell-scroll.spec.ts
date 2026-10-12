import { expect, invoke, test } from '../fixtures';

test('settings navigation and pane scrolling keep both headers in the window', async ({
  harness: h,
}) => {
  await invoke(h.page, 'settings.update', { onboardingCompleted: true });
  await h.page.getByTestId('tab-settings').waitFor();
  await h.page.getByRole('button', { name: 'Conecta una IA', exact: true }).click();

  const header = h.page.locator('main > header');
  const chatHeader = h.page.getByTestId('chat-panel').locator('header');
  const settingsScroll = h.page.locator('#pane-scroll > div > div');
  const assertWindow = async () => {
    await expect.poll(() => header.evaluate((el) => el.getBoundingClientRect().top)).toBe(0);
    expect(await chatHeader.evaluate((el) => el.getBoundingClientRect().top)).toBe(0);
    expect(await h.page.evaluate(() => window.scrollY)).toBe(0);
    expect(
      await h.page.getByTestId('chat-panel').evaluate((el) => el.getBoundingClientRect().bottom),
    ).toBe(await h.page.evaluate(() => window.innerHeight));
  };

  // Smooth section navigation used to shift the document by 56px, hiding both headers.
  await h.page.waitForTimeout(500);
  await assertWindow();

  await settingsScroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => settingsScroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await assertWindow();

  // Other scrollIntoView callers must also stay inside their pane.
  await h.page.locator('#pane-scroll h1').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await assertWindow();

  await h.page.getByTestId('tab-procedures').click();
  await expect(h.page.getByTestId('tab-procedures')).toHaveAttribute('aria-current', 'page');
  await assertWindow();
});
