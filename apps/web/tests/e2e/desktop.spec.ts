import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  // Contract test for frontend/IPC serialization. Native HTTP itself is tested in Rust.
  await page.addInitScript(() => {
    const target = window as unknown as { isTauri: boolean; desktopOffline: boolean; connectCalls: number; __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }
    target.isTauri = true
    target.desktopOffline = new URLSearchParams(location.search).has('offline')
    target.connectCalls = 0
    target.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command === 'desktop_connection') return { serverUrl: 'http://127.0.0.1:5181/' }
        if (command === 'desktop_connect') { target.connectCalls += 1; throw 'Сервер недоступен. Проверьте адрес и подключение' }
        if (command !== 'desktop_request') throw new Error(`Unexpected command: ${command}`)
        if (target.desktopOffline) throw 'Сервер недоступен. Проверьте адрес и подключение'
        const request = args!.request as { path: string; method: string; headers: Record<string, string>; bodyBase64: string | null }
        const body = request.bodyBase64 ? Uint8Array.from(atob(request.bodyBase64), c => c.charCodeAt(0)) : null
        const response = await fetch(request.path, { method: request.method, headers: request.headers, body, credentials: 'same-origin' })
        const bytes = new Uint8Array(await response.arrayBuffer())
        let text = ''
        for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768))
        return { status: response.status, headers: { 'content-type': response.headers.get('content-type') || '' }, bodyBase64: btoa(text) }
      },
    }
  })
})

test('desktop автоматически подключается, настройки не мешают входу и навигации', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Настройки', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByLabel('Адрес сервера')).not.toBeVisible()
  await page.getByLabel('Пароль', { exact: true }).fill(process.env.DEMO_PASSWORD || 'HryukersDemo2026!')
  await page.getByRole('button', { name: 'Войти в платформу' }).click()
  await expect(page.getByRole('heading', { name: 'Обзор платформы' })).toBeVisible()
  await page.getByRole('link', { name: 'Источники данных', exact: true }).click()
  await expect(page).toHaveURL(/#\/sources$/)
  await expect(page.getByRole('contentinfo').getByRole('button', { name: 'Настройки', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Настройки приложения' })).toBeVisible()
  await expect(page.getByLabel('Адрес сервера')).not.toBeVisible()
  await page.screenshot({ path: '../../.data/qa/desktop-settings.png' })
  await page.getByRole('button', { name: 'Изменить сервер' }).click()
  await expect(page.getByLabel('Адрес сервера')).toHaveValue('http://127.0.0.1:5181/')
  // An equivalent address must leave the current native session intact.
  await page.getByLabel('Адрес сервера').fill('http://127.0.0.1:5181')
  await page.getByRole('button', { name: 'Сохранить и подключиться' }).click()
  expect(await page.evaluate(() => (window as unknown as { connectCalls: number }).connectCalls)).toBe(0)
  await expect(page.getByLabel('Адрес сервера')).not.toBeVisible()
  await expect(page).toHaveURL(/#\/sources$/)
  await page.getByRole('button', { name: 'Изменить сервер' }).click()
  await page.getByLabel('Адрес сервера').fill('http://localhost:59999')
  await page.getByRole('button', { name: 'Сохранить и подключиться' }).click()
  await expect(page.getByRole('alert')).toContainText('Сервер недоступен')
  await page.getByRole('button', { name: 'Отмена', exact: true }).click()
  await expect(page.getByRole('alert')).not.toBeVisible()
  await page.getByRole('button', { name: 'Изменить сервер' }).click()
  await expect(page.getByLabel('Адрес сервера')).toHaveValue('http://127.0.0.1:5181/')
  await page.getByRole('button', { name: 'Отмена', exact: true }).click()
  await page.getByRole('button', { name: 'Готово', exact: true }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Войти в платформу' })).toBeVisible()
})

test('недоступный сервер показывает восстановление подключения вместо формы входа', async ({ page }) => {
  await page.goto('/?offline=1')
  await expect(page.getByRole('heading', { name: 'Не удалось подключиться' })).toBeVisible()
  await expect(page.getByLabel('Пароль', { exact: true })).not.toBeVisible()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page.screenshot({ path: '../../.data/qa/desktop-offline.png' })
  await page.getByRole('button', { name: 'Настройки подключения', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Нет связи с сервером')
  await page.getByRole('button', { name: 'Изменить сервер' }).click()
  await expect(page.getByLabel('Адрес сервера')).toHaveValue('http://127.0.0.1:5181/')
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click()
  await page.evaluate(() => { (window as unknown as { desktopOffline: boolean }).desktopOffline = false })
  await page.getByRole('button', { name: 'Повторить', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Войти в платформу' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Не удалось подключиться' })).not.toBeVisible()
})
