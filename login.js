const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

// Ensure the wallpapers directory exists
if (!fs.existsSync('wallpapers')) {
    fs.mkdirSync('wallpapers');
}

function generateRandomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function cleanHtml(html) {
    if (!html) return '';
    let clean = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
    clean = clean.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
    clean = clean.replace(/<!--[\s\S]*?-->/g, ' ');
    clean = clean.replace(/<[^>]+>/g, ' ');
    clean = clean.replace(/&nbsp;/gi, ' ')
                 .replace(/&amp;/gi, '&')
                 .replace(/&lt;/gi, '<')
                 .replace(/&gt;/gi, '>');
    return clean.replace(/\s+/g, ' ').trim();
}

async function dismissOnboarding(page) {
    console.log('Checking for onboarding screens or modals to dismiss...');
    // We will attempt to dismiss up to 5 consecutive onboarding screens/steps
    for (let step = 0; step < 5; step++) {
        let foundElement = null;
        let actionName = '';
        
        const locators = [
            { name: 'Skip', locator: page.locator('button, [role="button"], a, span').getByText('Skip', { exact: true }) },
            { name: 'Continue/Done/Got it', locator: page.locator('button:has-text("Continue"), [role="button"]:has-text("Continue"), button:has-text("Done"), button:has-text("Got it")') },
            { name: 'Let\'s go', locator: page.locator('button:has-text("Okay, let\'s go"), button:has-text("Let\'s go")') },
            { name: 'Close button', locator: page.locator('button[data-testid="close-button"], [aria-label="Close"]') }
        ];

        // Poll for visibility of any of these elements
        for (let attempt = 0; attempt < 8; attempt++) { // 8 * 500ms = 4 seconds max wait per step
            for (const item of locators) {
                if (await item.locator.count() > 0 && await item.locator.first().isVisible()) {
                    foundElement = item.locator.first();
                    actionName = item.name;
                    break;
                }
            }
            if (foundElement) break;
            await page.waitForTimeout(500);
        }

        if (foundElement) {
            console.log(`Found "${actionName}" onboarding button. Clicking it...`);
            await foundElement.click();
            // Wait 1.5 seconds for the transition after clicking
            await page.waitForTimeout(1500);
        } else {
            console.log('No onboarding screens or modals visible.');
            break;
        }
    }
}

async function checkSessionValid(page) {
    console.log('Checking if session is valid...');
    try {
        const expiredModal = page.locator('#modal-expired-session');
        const loginBtn = page.locator('[data-testid="login-button"]');
        
        if (await expiredModal.count() > 0 && await expiredModal.first().isVisible()) {
            console.log('Detected expired session modal.');
            return false;
        }
        
        if (await loginBtn.count() > 0 && await loginBtn.first().isVisible()) {
            console.log('Detected login button (session logged out).');
            return false;
        }
        
        return true;
    } catch (err) {
        console.error('Error during session validation check:', err.message);
        return false;
    }
}


let signupLock = Promise.resolve();

async function createNewSessionLocked(workerId) {
    let release;
    const waitPromise = new Promise(resolve => { release = resolve; });
    const previousLock = signupLock;
    signupLock = waitPromise;
    
    await previousLock;
    try {
        return await createNewSession(workerId);
    } finally {
        release();
    }
}

async function createNewSession(workerId) {
    console.log(`\n[Worker ${workerId}] --- Creating New Browser Session and Registering New Account ---`);

    let email = '';
    let uuid = '';
    try {
        console.log(`[Worker ${workerId}] Fetching active EduMails domains...`);
        const domainsRes = await fetch('https://api.edu-mails.com/api/domains');
        const domainsJson = await domainsRes.json();
        if (domainsJson.status !== 'success' || !domainsJson.data || !domainsJson.data.domains || domainsJson.data.domains.length === 0) {
            throw new Error('Failed to fetch domains from EduMails API: ' + JSON.stringify(domainsJson));
        }

        const domains = domainsJson.data.domains;
        const selectedDomain = domains[Math.floor(Math.random() * domains.length)];
        const alias = generateRandomString(10).toLowerCase();

        console.log(`[Worker ${workerId}] Generating EduMails temp email for custom alias: ${alias} on domain: ${selectedDomain.name} (id: ${selectedDomain.id})...`);
        const genRes = await fetch('https://api.edu-mails.com/api/emails/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'custom',
                alias: alias,
                domain_id: selectedDomain.id
            })
        });
        const genJson = await genRes.json();
        if (genJson.status !== 'success' || !genJson.data || !genJson.data.email) {
            throw new Error('Failed to generate email via EduMails: ' + JSON.stringify(genJson));
        }
        email = genJson.data.email.address;
        uuid = genJson.data.email.uuid;
        console.log(`[Worker ${workerId}] Successfully generated email: ${email} (uuid: ${uuid})`);
    } catch (err) {
        throw err;
    }

    // Now launch the main ChatGPT browser
    console.log(`[Worker ${workerId}] Launching main browser process for ChatGPT...`);
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    try {
        console.log(`[Worker ${workerId}] Navigating to ChatGPT...`);
        await page.goto('https://chatgpt.com/', { waitUntil: 'load' });

        const loginBtn = page.locator('[data-testid="login-button"]');
        await loginBtn.waitFor({ state: 'visible' });
        await loginBtn.click();

        const chatgptEmailInput = page.locator('input#email');
        await chatgptEmailInput.waitFor({ state: 'visible' });

        console.log(`[Worker ${workerId}] Entering registration email: ${email}`);
        await chatgptEmailInput.fill(email);
        await chatgptEmailInput.press('Enter');

        // Fallback: If still on same screen, click Continue button directly
        await page.waitForTimeout(2000);
        const continueBtn = page.locator('button[type="submit"]:has-text("Continue"), button:has-text("Continue")');
        if (await continueBtn.count() > 0 && await continueBtn.isVisible()) {
            console.log(`[Worker ${workerId}] Clicking the Continue button directly...`);
            await continueBtn.click();
        }

        console.log(`[Worker ${workerId}] Waiting for verification page (waiting for code input)...`);
        const codeInput = page.locator('input[name="code"], input[placeholder="Code"], input[id$="-code"]');
        await codeInput.waitFor({ state: 'visible' });

        // Retrieve OTP using EduMails API
        console.log(`[Worker ${workerId}] Checking EduMails inbox for ChatGPT verification email...`);
        let otp = null;
        for (let attempt = 1; attempt <= 30; attempt++) {
            try {
                const mailRes = await fetch(`https://api.edu-mails.com/api/emails/${uuid}`);
                const mailJson = await mailRes.json();
                if (mailJson.status === 'success' && mailJson.data && mailJson.data.messages) {
                    const messages = mailJson.data.messages;
                    const relevantMessage = messages.find(msg => 
                        (msg.from && (msg.from.includes('ChatGPT') || msg.from.includes('OpenAI') || msg.from.includes('openai.com'))) ||
                        (msg.subject && (msg.subject.includes('ChatGPT') || msg.subject.includes('verification'))) ||
                        (msg.body && (msg.body.includes('ChatGPT') || msg.body.includes('verification')))
                    );
                    
                    if (relevantMessage) {
                        const cleanedBody = cleanHtml(relevantMessage.body);
                        const contentToSearch = `${relevantMessage.subject || ''} ${cleanedBody}`;
                        const otpMatch = contentToSearch.match(/\b\d{6}\b/);
                        if (otpMatch) {
                            otp = otpMatch[0];
                            break;
                        }
                    }
                }
            } catch (err) {
                console.error(`[Worker ${workerId}] Error checking inbox (attempt ${attempt}/30):`, err.message);
            }
            console.log(`[Worker ${workerId}] Email not arrived yet or OTP not found (attempt ${attempt}/30). Waiting 5 seconds...`);
            await page.waitForTimeout(5000);
        }

        if (!otp) {
            throw new Error('Verification email from ChatGPT did not arrive or OTP could not be extracted.');
        }
        console.log(`[Worker ${workerId}] Successfully retrieved OTP: ${otp}`);

        // Bring the ChatGPT page to the front to ensure it is focused and not throttled
        console.log(`[Worker ${workerId}] Bringing ChatGPT tab to front...`);
        await page.bringToFront();
        await page.waitForTimeout(1000);

        // Fill in OTP on ChatGPT
        console.log(`[Worker ${workerId}] Entering OTP code: ${otp} on ChatGPT...`);
        await codeInput.focus();
        await codeInput.fill(otp);

        // Wait a brief moment to see if it submits automatically and navigates
        await page.waitForTimeout(3000);

        // If nameInput is not visible yet, try to find and click the submit button
        const nameInput = page.locator('input[name="name"], input[placeholder="Full name"]');
        if (await nameInput.count() === 0 || !(await nameInput.isVisible())) {
            console.log(`[Worker ${workerId}] Form did not auto-submit. Locating and clicking submit/continue button...`);
            const submitBtn = page.locator('button[type="submit"][value="validate"], button:has-text("Continue")');
            if (await submitBtn.count() > 0 && await submitBtn.isVisible()) {
                await submitBtn.click().catch(err => console.log(`[Worker ${workerId}] Submit button click ignored:`, err.message));
            }
        }

        // Wait for profile setup form (About You) page
        console.log(`[Worker ${workerId}] Waiting for Profile Setup (About You) page to load...`);
        await nameInput.waitFor({ state: 'visible' });

        console.log(`[Worker ${workerId}] Filling Profile Info (Name & Age)...`);
        await nameInput.fill('jahid hasan');

        const ageInput = page.locator('input[name="age"], input[placeholder="Age"]');
        await ageInput.waitFor({ state: 'visible' });
        await ageInput.fill('30');

        console.log(`[Worker ${workerId}] Submitting Profile Info...`);
        const finishBtn = page.locator('button[type="submit"]:has-text("Finish creating account"), button:has-text("Finish creating account")');
        await finishBtn.click();

        console.log(`[Worker ${workerId}] Waiting for redirect back to ChatGPT...`);
        await page.waitForURL('**/chatgpt.com/**', { waitUntil: 'domcontentloaded' });

        await dismissOnboarding(page);

        console.log(`[Worker ${workerId}] New account session successfully created and logged in.`);

        const emailsFilePath = path.join(__dirname, 'emails.txt');
        fs.appendFileSync(emailsFilePath, `${email}\n`, 'utf8');
        console.log(`[Worker ${workerId}] Saved registered email: ${email} to ${emailsFilePath}`);

        return { browser, page };

    } catch (error) {
        console.error(`[Worker ${workerId}] An error occurred during account creation:`, error);
        try {
            console.error(`[Worker ${workerId}] Current Page URL:`, page.url());
            console.error(`[Worker ${workerId}] Current Page Title:`, await page.title());
            const bodyText = await page.innerText('body').catch(() => '');
            console.error(`[Worker ${workerId}] Page Body Text Snippet (first 800 chars):`, bodyText.slice(0, 800));
        } catch (diagErr) {
            console.error(`[Worker ${workerId}] Failed to capture diagnostic page details:`, diagErr.message);
        }
        await page.screenshot({ path: `wallpapers/error_signup_worker_${workerId}.png`, fullPage: true });
        await browser.close().catch(() => { });
        throw error;
    }
}

(async () => {
    // Read prompts from prompts.txt
    let prompts = [];
    const promptsPath = path.join(__dirname, 'prompts.txt');
    if (fs.existsSync(promptsPath)) {
        prompts = fs.readFileSync(promptsPath, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        console.log(`Loaded ${prompts.length} prompt(s) from prompts.txt.`);
    }

    if (prompts.length === 0) {
        console.log('No prompts found in prompts.txt. Using default prompts...');
        prompts = [
            'Create image a wallpaper 9:16 ratio of a serene mountain sunrise',
            'Create image a wallpaper 9:16 ratio of a neon cyberpunk city street',
            'Create image a wallpaper 9:16 ratio of a futuristic spaceship in orbit'
        ];
    }

    // Set up queue tasks
    const tasks = prompts.map((promptText, i) => ({
        text: promptText,
        index: i,
        retries: 0
    }));

    const concurrency = 10;
    const workerPromises = [];

    console.log(`Starting bulk image generation with ${concurrency} parallel workers...`);

    for (let w = 1; w <= concurrency; w++) {
        workerPromises.push((async (workerId) => {
            console.log(`[Worker ${workerId}] Initialized.`);
            let currentSession = null;
            let generationsOnCurrentAccount = 0;
            const maxPromptRetries = 2;

            while (true) {
                // Fetch the next task in a thread-safe (JS-atomic) manner
                const task = tasks.shift();
                if (!task) {
                    break; // Queue is empty, exit worker
                }

                console.log(`\n======================================================`);
                console.log(`[Worker ${workerId}] Processing Prompt ${task.index + 1}/${prompts.length}`);
                console.log(`[Worker ${workerId}] Prompt: "${task.text}"`);
                console.log(`======================================================`);

                // Rotate browser session / account if generations reach limit of 5
                if (!currentSession || generationsOnCurrentAccount >= 5) {
                    if (currentSession) {
                        console.log(`[Worker ${workerId}] Reached 5 generations limit. Closing browser and rotating account...`);
                        await currentSession.browser.close().catch(() => { });
                        currentSession = null;
                    }
                    try {
                        // Use the locked signup creator to stagger registration
                        currentSession = await createNewSessionLocked(workerId);
                        generationsOnCurrentAccount = 0;
                    } catch (err) {
                        console.error(`[Worker ${workerId}] Failed to rotate account session:`, err.message);
                        console.log(`[Worker ${workerId}] Waiting 10 seconds before retrying...`);
                        await new Promise(res => setTimeout(res, 10000));
                        // Put the task back to the front of the queue
                        tasks.unshift(task);
                        continue;
                    }
                }

                const page = currentSession.page;

                try {
                    console.log(`[Worker ${workerId}] Resetting interface to start a fresh chat session...`);
                    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });

                    await dismissOnboarding(page);

                    // Verify session is still valid
                    const sessionValid = await checkSessionValid(page);
                    if (!sessionValid) {
                        console.log(`[Worker ${workerId}] Session is invalid/expired. Forcing session rotation...`);
                        throw new Error('SessionExpiredOrInvalid');
                    }

                    console.log(`[Worker ${workerId}] Locating prompt input text area (#prompt-textarea)...`);
                    const promptArea = page.locator('#prompt-textarea');
                    await promptArea.waitFor({ state: 'visible' });

                    console.log(`[Worker ${workerId}] Focusing and typing the image prompt...`);
                    await promptArea.click();
                    let finalPrompt = task.text;
                    if (!task.text.includes('9:16') && !task.text.toLowerCase().includes('aspect ratio')) {
                        finalPrompt = `Create a vertical 9:16 aspect ratio wallpaper of: ${task.text}`;
                    }
                    console.log(`[Worker ${workerId}] Typing formatted prompt: "${finalPrompt}"`);
                    await page.keyboard.type(finalPrompt);
                    await page.waitForTimeout(1000);

                    console.log(`[Worker ${workerId}] Locating send button...`);
                    const sendBtn = page.locator('[data-testid="send-button"], #composer-submit-button');
                    await sendBtn.waitFor({ state: 'visible' });

                    console.log(`[Worker ${workerId}] Clicking the send button...`);
                    await sendBtn.click();

                    console.log(`[Worker ${workerId}] Waiting for image generation to complete...`);
                    // Wait for the image container to appear with an actual img src
                    const imageImgLocator = page.locator('.group\\/imagegen-image img[src*="estuary/content"]').first();
                    await imageImgLocator.waitFor({ state: 'visible', timeout: 120000 });

                    console.log(`[Worker ${workerId}] Image generated! Extracting image URL from DOM...`);
                    const imageUrl = await imageImgLocator.getAttribute('src');
                    if (!imageUrl) {
                        throw new Error('Could not extract image URL from generated image element.');
                    }
                    console.log(`[Worker ${workerId}] Extracted image URL: ${imageUrl.substring(0, 100)}...`);

                    // Download the image directly using browser fetch (sends cookies automatically)
                    const fileIndex = task.index + 1;
                    const filePath = path.join('wallpapers', `wallpaper_${fileIndex}.png`);
                    console.log(`[Worker ${workerId}] Downloading image directly to: ${filePath}`);

                    const imageBuffer = await page.evaluate(async (url) => {
                        const response = await fetch(url, { credentials: 'include' });
                        if (!response.ok) throw new Error(`Fetch failed with status: ${response.status}`);
                        const arrayBuffer = await response.arrayBuffer();
                        return Array.from(new Uint8Array(arrayBuffer));
                    }, imageUrl);

                    fs.writeFileSync(filePath, Buffer.from(imageBuffer));
                    console.log(`[Worker ${workerId}] Wallpaper successfully downloaded and saved to: ${filePath}`);

                    generationsOnCurrentAccount++;
                    console.log(`[Worker ${workerId}] Generations on current account: ${generationsOnCurrentAccount}/5`);

                } catch (error) {
                    console.error(`[Worker ${workerId}] Error processing prompt ${task.index + 1}:`, error.message || error);
                    try {
                        await page.screenshot({ path: `wallpapers/error_prompt_${task.index + 1}_worker_${workerId}.png`, fullPage: true });
                    } catch (snapErr) {
                        console.error(`[Worker ${workerId}] Failed to take screenshot:`, snapErr.message);
                    }

                    // Since an error occurred, check if we should discard the session
                    let shouldDiscardSession = false;

                    // 1. Check if the session is expired or logged out
                    try {
                        const sessionValid = await checkSessionValid(page);
                        if (!sessionValid) {
                            shouldDiscardSession = true;
                        }
                    } catch (checkErr) {
                        console.error(`[Worker ${workerId}] Failed to check session status after error:`, checkErr.message);
                        shouldDiscardSession = true;
                    }

                    // 2. Also discard session if there was a timeout (which could mean rate limit / stuck UI)
                    if (error.name === 'TimeoutError' || error.message.includes('timeout') || error.message.includes('Timeout')) {
                        console.log(`[Worker ${workerId}] Timeout detected. Discarding session to rotate account...`);
                        shouldDiscardSession = true;
                    }

                    if (shouldDiscardSession) {
                        if (currentSession) {
                            await currentSession.browser.close().catch(() => {});
                            currentSession = null;
                        }
                    }

                    if (task.retries < maxPromptRetries) {
                        task.retries++;
                        console.log(`[Worker ${workerId}] Retrying prompt ${task.index + 1} (attempt ${task.retries}/${maxPromptRetries})...`);
                        tasks.unshift(task); // Re-queue task to retry
                    } else {
                        console.log(`[Worker ${workerId}] Maximum retries reached for prompt ${task.index + 1}. Moving to next prompt.`);
                    }
                }
            }

            if (currentSession) {
                await currentSession.browser.close().catch(() => { });
                console.log(`[Worker ${workerId}] Browser closed. Worker finished.`);
            }
        })(w));
    }

    await Promise.all(workerPromises);
    console.log('\nAll workers finished. Bulk generation complete.');
})();
