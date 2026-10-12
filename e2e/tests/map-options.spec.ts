import { expect, test } from '@playwright/test';

// Use the cached full Chromium browser; never install an additional headless shell.
test.use({ channel: 'chromium', viewport: { width: 1280, height: 820 } });

for (const lang of ['es', 'en']) {
  for (const home of ['none', 'address']) {
    test(`map selection works with mouse and keyboard (${lang}, home=${home})`, async ({
      page,
    }) => {
      const externalRequests: string[] = [];
      const pageErrors: string[] = [];
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)) {
          return route.continue();
        }
        externalRequests.push(url.origin);
        return route.abort();
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(
        `http://127.0.0.1:5186/?map=1&freeze=1&lang=${lang}${home === 'none' ? '' : `&${home}=1`}`,
      );
      if (home === 'none') {
        await page
          .getByRole('button', {
            name: lang === 'es' ? 'Continuar sin dirección' : 'Continue without an address',
            exact: true,
          })
          .click();
      }
      const questions = page.getByTestId('card-questions');
      const group = questions.getByRole('radiogroup');
      const map = questions.locator('.leaflet-container');
      await expect(group.getByRole('radio')).toHaveCount(3);
      await expect(questions.getByRole('combobox')).toHaveCount(0);
      await expect(map.locator('.leaflet-tile-loaded').first()).toBeVisible();
      if (home !== 'none') {
        // A saved address skips the address step and sorts places by distance.
        await expect(questions.getByText(/^\d[\d.,]* k?m$/).first()).toBeVisible();
        await expect(
          questions.getByText(lang === 'es' ? /Elige un lugar/ : /Choose a place/),
        ).toHaveCount(0);
      }

      await group.getByRole('radio', { name: /2 · Centro Sur/ }).check();
      const north = map.getByRole('button', { name: 'Centro Norte (demo)', exact: true });
      const east = map.getByRole('button', { name: 'Centro Este (demo)', exact: true });
      const showAll = questions.getByRole('button', {
        name: lang === 'es' ? 'Ver todos' : 'Show all',
        exact: true,
      });
      await showAll.click();
      await map.scrollIntoViewIfNeeded();
      await north.click();
      await expect(group.getByRole('radio', { name: /1 · Centro Norte/ })).toBeChecked();
      await expect(north).toHaveAttribute('aria-pressed', 'true');

      await showAll.click();
      await map.scrollIntoViewIfNeeded();
      await east.focus();
      await east.press('Enter');
      await expect(group.getByRole('radio', { name: /3 · Centro Este/ })).toBeChecked();
      await expect(east).toBeFocused();
      await expect(east).toHaveAttribute('aria-pressed', 'true');
      // Activation must not submit the enclosing form.
      await expect(questions).toBeVisible();
      await expect(north).toHaveAttribute('aria-pressed', 'false');

      await showAll.click();
      await map.scrollIntoViewIfNeeded();
      await north.focus();
      await north.press('Space');
      await expect(group.getByRole('radio', { name: /1 · Centro Norte/ })).toBeChecked();
      await expect(north).toBeFocused();
      await expect(questions).toBeVisible();

      await questions.locator('button[type="submit"]').click();
      await expect(questions).toHaveCount(0);
      expect(externalRequests).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }
}

test('a typed address is located and saved without choosing from a list', async ({ page }) => {
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:5186/?map=1&freeze=1&lang=es');
  const questions = page.getByTestId('card-questions');
  await questions.getByLabel('Calle y número').fill('Calle de ejemplo 10');
  await questions.getByLabel('Municipio').fill('Sevilla');
  await questions.getByRole('button', { name: 'Buscar mi dirección', exact: true }).click();
  await expect(questions.getByText('Tu casa: Calle de ejemplo 10, Sevilla, España')).toBeVisible();
  await expect(questions.getByRole('button', { name: 'Cambiar', exact: true })).toBeVisible();
  await expect(questions.getByText(/^\d[\d.,]* k?m$/).first()).toBeVisible();
  await expect(questions.getByRole('radio')).toHaveCount(3);
});
