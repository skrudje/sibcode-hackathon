import { test, expect } from '@playwright/test'

test('рабочее окно: быстрый переход, клавиатура, сохранённое меню и закреплённый статус', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByLabel('Пароль', { exact: true }).fill(process.env.DEMO_PASSWORD || 'HryukersDemo2026!')
  await page.getByRole('button', { name: 'Войти в платформу' }).click()
  await expect(page.getByRole('heading', { name: 'Обзор платформы' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('Сервер доступен')
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('combobox', { name: 'Найти раздел' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Источники данных', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).not.toBeVisible()

  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: 'Найти раздел' }).fill('несуществующий раздел')
  await expect(page.getByText('Раздел не найден.', { exact: false })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Быстрый переход', exact: true }).click()
  await page.getByRole('combobox', { name: 'Найти раздел' }).fill('клиенты')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Клиенты', exact: true })).toBeVisible()

  // A desktop shortcut must not steal a text editing gesture in a field.
  await page.getByRole('textbox', { name: 'Поиск клиентов' }).focus()
  await page.keyboard.press('Control+b')
  await expect(page.getByRole('button', { name: 'Свернуть меню', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('heading', { name: 'Клиенты', exact: true }).click()
  await page.keyboard.press('Control+b')
  await expect(page.getByRole('button', { name: 'Развернуть меню', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Развернуть меню', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Alt+1')
  await expect(page.getByRole('heading', { name: 'Обзор платформы' })).toBeVisible()

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 900, height: 640 }]) {
    await page.setViewportSize(viewport)
    const status = page.getByRole('contentinfo', { name: 'Состояние платформы' })
    await expect(status).toBeVisible()
    const before = await status.boundingBox()
    await page.locator('#workspace-content').evaluate(el => { el.scrollTop = el.scrollHeight })
    expect((await status.boundingBox())?.y).toBe(before?.y)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBeTruthy()
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.route('**/api/v1/health/ready', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'unavailable', message: 'Сервер временно недоступен' } }),
  }))
  await page.getByRole('button', { name: 'Обновить данные', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Нет связи с сервером')
  await page.unroute('**/api/v1/health/ready')
  await expect(page.getByRole('button', { name: 'Обновить данные', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Обновить данные', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Сервер доступен')
  await page.getByRole('button', { name: 'Развернуть меню', exact: true }).click()
  await page.locator('#workspace-content').evaluate(el => { el.scrollTop = 0 })
  await page.screenshot({ path: '../../.data/qa/desktop-workspace.png' })
  expect(errors).toEqual([])
})
