import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

test('экран входа, ошибка пароля и обзор', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Добро пожаловать' })).toBeVisible()
  await mkdir('../../.data/qa', { recursive: true })
  await page.screenshot({ path: '../../.data/qa/login.png', fullPage: true })
  await page.getByLabel('Пароль', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: 'Войти в платформу' }).click()
  await expect(page.getByRole('alert')).toContainText('Неверный email или пароль')
  await page.getByLabel('Пароль', { exact: true }).fill(process.env.DEMO_PASSWORD || 'HryukersDemo2026!')
  await page.getByRole('button', { name: 'Войти в платформу' }).click()
  await expect(page.getByRole('heading', { name: 'Обзор платформы' })).toBeVisible()
  await page.screenshot({ path: '../../.data/qa/overview-empty.png', fullPage: true })
})
