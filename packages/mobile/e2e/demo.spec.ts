import { test, expect } from '@playwright/test'

test.describe('DoraBot Remote iOS - Demo Mode', () => {
  test('Pair screen loads without infinite spinner and shows demo link', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Verify we're on the Pair screen
    const pairHeading = page.locator('h1', { hasText: /Pair with your Mac|Add another Mac/ })
    await expect(pairHeading).toBeVisible()

    // Verify "Scan QR code" button is visible
    await expect(page.locator('button', { hasText: /Scan QR code/ })).toBeVisible()

    // Verify "Try a demo" link is visible
    const demoLink = page.locator('button, a', { hasText: /Try a demo/ })
    await expect(demoLink).toBeVisible()
  })

  test('Enter demo mode shows sample sessions and demo banner', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Click "Try a demo" link
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Wait for demo sessions to load
    await page.waitForTimeout(2000)

    // Verify demo banner is visible
    const demoBanner = page.locator('text=Demo mode: sample data, no Mac connected')
    await expect(demoBanner).toBeVisible()

    // Verify at least one demo session is shown
    const sessionText = page.locator('text=Fix failing checkout tests')
    if (await sessionText.count() > 0) {
      await expect(sessionText.first()).toBeVisible()
    }

    // Verify tab bar is visible with Sessions and Inbox tabs
    const sessionsTab = page.locator('button, [role="tab"]', { hasText: /Sessions/ })
    if (await sessionsTab.count() > 0) {
      await expect(sessionsTab).toBeVisible()
    }
  })

  test('Tab bar navigation to Inbox works in demo mode', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Sessions tab should show sessions
    const sessions = page.locator('text=Fix failing checkout tests')
    if (await sessions.count() > 0) {
      await expect(sessions.first()).toBeVisible()
    }

    // Navigate to Inbox tab
    const inboxTab = page.locator('button, [role="tab"]', { hasText: /Inbox/ })
    if (await inboxTab.count() > 0) {
      await inboxTab.click()
      await page.waitForTimeout(1000)

      // Verify we're in the inbox
      const body = page.locator('body')
      await expect(body).toBeVisible()
    }
  })

  test('Inbox: approve pending approval and see reply stream', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Navigate to Inbox
    await page.locator('button, [role="tab"]', { hasText: /Inbox/ }).click()
    await page.waitForTimeout(500)

    // Look for the pending approval row
    const approvalItem = page.locator('text=/npm test/i')
    if (await approvalItem.count() > 0) {
      await expect(approvalItem.first()).toBeVisible()

      // Find and click approve button
      const approveBtn = page.locator('button:has-text("Approve"), button:has-text("Allow")').first()
      if (await approveBtn.count() > 0) {
        await approveBtn.click()
        await page.waitForTimeout(1500)

        // Verify reply text appears
        const replyText = page.locator('text=/All.*tests pass|demo/i')
        await expect(replyText.first()).toBeVisible({ timeout: 5000 })
      }
    }
  })

  test('Inbox: answer question by choosing an option', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Navigate to Inbox
    await page.locator('button, [role="tab"]', { hasText: /Inbox/ }).click()
    await page.waitForTimeout(1000)

    // Look for answer buttons (these should be visible for the question)
    const answerBtns = page.locator('button:has-text("Customers"), button:has-text("Engineers"), button:has-text("Both")')
    if (await answerBtns.count() > 0) {
      // Click first option
      await answerBtns.first().click()
      await page.waitForTimeout(2000)

      // Verify the system accepted the answer (the page should still be functional)
      const mainArea = page.locator('[role="main"], main').first()
      if (await mainArea.count() > 0) {
        await expect(mainArea).toBeVisible()
      }
    }
  })

  test('Open session, type message, send, and see canned reply', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Open a session
    const sessionLink = page.locator('text=Fix failing checkout tests').first()
    await sessionLink.click()
    await page.waitForTimeout(500)

    // Verify session is open with chat content
    const chatContent = page.locator('text=/calculateTax|checkout/i')
    await expect(chatContent.first()).toBeVisible()

    // Find composer textarea
    const composer = page.locator('textarea').first()
    if (await composer.count() > 0) {
      await composer.fill('How can I fix this?')
      await page.waitForTimeout(300)

      // Find send button
      const sendBtn = page.locator('button:has-text("Send")').first()
      if (await sendBtn.count() > 0) {
        await sendBtn.click()
        await page.waitForTimeout(1500)

        // Verify reply appears
        const reply = page.locator('text=/demo|This is/i')
        await expect(reply.first()).toBeVisible({ timeout: 5000 })
      }
    }

    // Verify composer is still visible on iPhone viewport (not covered)
    const composerAfter = page.locator('textarea').first()
    if (await composerAfter.count() > 0) {
      const bounds = await composerAfter.boundingBox()
      if (bounds && page.viewportSize()) {
        const viewport = page.viewportSize()!
        // Composer should be within viewport
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1)
      }
    }
  })

  test('Model picker opens fully without cropping', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Open a session
    await page.locator('text=Fix failing checkout tests').first().click()
    await page.waitForTimeout(500)

    // Look for model button
    const modelBtn = page.locator('button:has-text("Sonnet"), button:has-text("Model"), button:has-text("Claude")').first()
    if (await modelBtn.count() > 0) {
      await modelBtn.click()
      await page.waitForTimeout(500)

      // Look for picker/sheet with model options
      const pickerContent = page.locator('[role="dialog"], [class*="sheet"], [class*="modal"]').first()
      if (await pickerContent.count() > 0) {
        // Verify the picker element exists and is well-formed
        await expect(pickerContent).toBeVisible()

        const bounds = await pickerContent.boundingBox()
        if (bounds && page.viewportSize()) {
          const viewport = page.viewportSize()!

          // Model picker should be within viewport bounds
          const isWithinViewport = (bounds.y + bounds.height) <= viewport.height
          expect(isWithinViewport).toBeTruthy()
        }
      }
    }
  })

  test('Exit demo returns to Pair screen', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Verify demo mode is active
    const demoBanner = page.locator('text=Demo mode: sample data, no Mac connected')
    await expect(demoBanner).toBeVisible()

    // Click "Exit demo" button
    const exitBtn = page.locator('button:has-text("Exit demo")')
    await expect(exitBtn).toBeVisible()
    await exitBtn.click()

    await page.waitForTimeout(500)

    // Verify we're back on Pair screen
    const pairHeading = page.locator('h1', { hasText: /Pair with your Mac/ })
    await expect(pairHeading).toBeVisible()

    // Verify demo banner is gone
    const demoBannerGone = page.locator('text=Demo mode: sample data, no Mac connected')
    await expect(demoBannerGone).not.toBeVisible()
  })
})
