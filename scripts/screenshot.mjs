#!/usr/bin/env node
// Drive the hub's bundle page in headless Chrome and capture a screenshot.
// Usage: node scripts/screenshot.mjs <url> <output.png>
import { createRequire } from 'node:module'

const puppeteerFrom = process.env.PUPPETEER_FROM
if (!puppeteerFrom) {
  console.error('set PUPPETEER_FROM to a package.json whose node_modules contains puppeteer-core')
  process.exit(2)
}
const require = createRequire(puppeteerFrom)
const puppeteer = require('puppeteer-core')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const [, , url, output] = process.argv
if (!url || !output) {
  console.error('usage: node scripts/screenshot.mjs <url> <output.png>')
  process.exit(2)
}

async function clickText(page, text) {
  const box = await page.evaluate((needle) => {
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], [role="tab"], div, span'))
    const target = nodes.filter((node) => (node.textContent || '').trim() === needle).pop()
    if (!target) return null
    const rect = target.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }, text)
  if (!box) return false
  await page.mouse.click(box.x, box.y)
  return true
}

async function waitForText(page, text, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await page.evaluate((needle) => document.body.innerText.includes(needle), text)) return true
    await wait(300)
  }
  return false
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--user-data-dir=/tmp/dsh-chrome-${process.pid}`],
  timeout: 120000,
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  const errors = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
  await wait(4000)
  if (await waitForText(page, 'Add API Key', 4000)) {
    await clickText(page, 'Add API Key')
    await wait(1500)
    await clickText(page, 'Configure later')
    await wait(2000)
  }
  await clickText(page, 'Plugins')
  await waitForText(page, 'Installed plugins', 20000)
  await wait(1200)
  await clickText(page, 'dsh-connect-hub')
  await wait(3000)
  await page.screenshot({ path: output })
  const text = await page.evaluate(() => document.body.innerText)
  console.log(JSON.stringify({ output, errors: errors.slice(0, 20), text: text.slice(0, 1500) }, null, 2))
} finally {
  await browser.close()
}
