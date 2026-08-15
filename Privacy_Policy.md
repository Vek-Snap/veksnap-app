PRIVACY POLICY
Vek-Snap by Squishy Code AI LLC

Version 1.1 - Effective Date: August 15, 2026

This policy covers (a) the Vek-Snap desktop application and Guided Installer, which run 100% offline on your own computer, and (b) the Squishy Code website and storefront (`squishycode.ai`), where purchases are processed by our merchant of record, Lemon Squeezy.

---

1. The Short Version

Vek-Snap is offline software. We do not collect, transmit, store, sell, or share your prompts, input files, generated content, or usage activity. The application contains no analytics, no telemetry, and no ongoing "phone-home" behavior. The one exception is a single license-key activation the first time you run a purchased copy (see Section 5); everything you create stays on your own device unless you choose to move it.

The only place we (through our merchant of record) process limited personal information is when you buy Vek-Snap on our website, see Section 6.

Because the source code is publicly available under the PolyForm Noncommercial License 1.0.0, you (or anyone) can independently verify these claims.

---

2. Who We Are

Squishy Code AI LLC ("Squishy Code," "we," "us"), a Nevada limited liability company, makes the Vek-Snap software. For privacy questions, contact legal@squishycode.ai (legal notices) or contact@squishycode.ai (general and support).

---

3. Information the Application Does NOT Collect

The installed Vek-Snap application and the Guided Installer do not collect or transmit:
- Your text prompts, settings, or workflow configurations.
- Your input files (images, audio, video, reference media) or generated output.
- Personal identifiers, account profiles, device fingerprints, or location.
- Analytics, telemetry, crash reports, behavioral metrics, or usage statistics.

We operate no servers that receive your content. We have no ability to see what you create.

Technical measures that enforce this (verifiable in source): Next.js telemetry is disabled (`NEXT_TELEMETRY_DISABLED=1`); the local UI and the ComfyUI backend bind only to `127.0.0.1` (loopback); no analytics, advertising, Sentry, or third-party CDN is included; and an offline mode blocks model-downloader network egress.

---

4. Data Stored Locally on Your Device

Vek-Snap reads and writes data only on your own computer, typically within the installation directory and your operating system's temporary folder. None of it is sent to us. This includes:
- App settings and window or session state (e.g. `veksnap-settings.json`).
- Project restore points and autosaves you create.
- Uploaded source media you provide (reference images, audio, video), stored in the local `ComfyUI/input` folder until you clear it.
- Generated output (renders, Movie Maker artifacts), stored in `ComfyUI/output`.
- Intermediate and working files and caches (e.g. `ComfyUI/temp`, browser cache, logs, the local model cache).

You control this data. Vek-Snap includes a built-in "Clear Temporary Files" feature (with per-category sizes and a "Clear All"), a protected handling of your rendered output, and an optional "clear working files on exit" setting (off by default). Uninstalling and deleting the install directory removes your local data; your finished renders are preserved unless you choose to delete them.

Our MetaGuard utility can strip identifying metadata from media you export.

---

5. Network Connections, Only When You Choose Them

Vek-Snap is usable offline, but certain optional, clearly-indicated actions reach the internet. When they do, your request goes directly from your machine to the relevant third party. It does not pass through Squishy Code, and we receive no data from it:
- Downloading AI models from third-party repositories (e.g. Hugging Face) when you select models to install. Those providers' own privacy terms apply to your connection to them.
- Fetching runtime components during setup, for example, the FFmpeg static build is downloaded directly from its upstream project (BtbN), and ComfyUI and certain custom nodes are cloned from their upstream repositories. We do not proxy, mirror, or log these requests.
- Installing Python and PyTorch dependencies from their official package indexes at install time.
- A one-time license activation the first time you run a purchased copy: your license key is validated once with Lemon Squeezy, after which the application continues to run offline. This is a single activation check, not ongoing telemetry, and no prompts, files, or usage data are sent. Your license may be activated on a limited number of devices you own (currently up to five).
- Checking for updates, and only when you click "Check for updates" (Help then About) with Network Access enabled. Vek-Snap fetches a small public version file to see whether a newer release exists. It is a plain download of a version list, with no prompts, files, identifiers, or usage data sent, and there is no automatic or background update checking.

Apart from the one-time activation, these connections happen only because you initiated an install or a download, and each is disclosed in the setup flow.

As with any internet request, the third parties you connect to for these actions (model repositories, BtbN for FFmpeg, the ComfyUI and custom-node repositories, the Python and PyTorch package indexes, Lemon Squeezy for activation, and the update-feed host) necessarily receive the standard technical metadata inherent to an HTTP request, such as your IP address and a basic user-agent. This is a property of connecting to the internet, not Vek-Snap telemetry: Squishy Code does not collect, receive, or log that metadata, and no prompts, files, identifiers, or usage data are added to these requests. When we say "no telemetry," we mean the Software performs no analytics and sends us no product, usage, or content data, not that an opt-in connection to a third party is invisible to that third party.

---

6. The Website and Storefront (Where We Do Process Personal Data)

When you purchase Vek-Snap through our website (`squishycode.ai`), the transaction is handled by our merchant of record, Lemon Squeezy. In that context, limited personal information is processed:
- Your email address (to deliver your download and license key, and for receipts and support).
- Payment information, collected and processed by Lemon Squeezy and its payment processors, not by us. We do not receive or store your full card details.
- Billing and tax information Lemon Squeezy requires to handle sales tax or VAT as merchant of record.
- Your license key and basic order records, so we can provide support and honor your license.

Lemon Squeezy acts as the seller of record for the transaction and processes this data under its own privacy policy, which we encourage you to review. We use the information you provide only to fulfill your order, deliver your license, provide support, and meet legal and accounting obligations. We do not sell your personal information.

If our website later uses any cookies (e.g. for an embedded checkout), that use will be limited to what is necessary for the purchase and disclosed at the point of collection. [Confirm cookie and embed behavior at launch.]

6.1 Support and diagnostic files you choose to send us

If you contact support, or if at our request you use the app's "Export Diagnostics" or "Export All logs" feature and send us the result, we receive only what you choose to send. Before writing these files, Vek-Snap scrubs your Windows account name from file paths and text, and it never records your prompt text (only a prompt length is ever logged) or your generated content. Even so, a diagnostic file can still contain technical details you configured, for example, custom folder paths or the names of your own models and output files, and license-validation data we use to confirm a genuine purchase. You may review or redact a file before sending it, and we use it solely to investigate your issue. When you email us, we also receive your email address and whatever you include in your message. We will provide a short reminder of this at the point where you submit a report.

---

7. AI-Generated Content

Vek-Snap generates media locally using AI models that run on your hardware. Your prompts and outputs are never transmitted to us, and we do not use your prompts, inputs, or generated content to train, fine-tune, or improve any model. You are responsible for the content you create and how you use it, as described in the End User License Agreement. Because AI Output can be inaccurate or non-unique, it is provided for creative and informational purposes only and is not a substitute for professional advice. Third-party AI models you download are governed by their own licenses and terms, which may include their own restrictions.

---

8. Children's Privacy

Vek-Snap is intended for users 18 years or older. We do not knowingly collect personal information from children. The application does not collect personal information from anyone.

---

9. Data Security

Because the application is offline and we do not collect your content, your creative data never leaves your control. For website purchases, payment security is handled by Lemon Squeezy and its PCI-compliant processors. No method of transmission or storage is perfectly secure, and we cannot guarantee absolute security of data processed by third parties.

---

10. Your Rights and Choices

- In the app: clear working files and caches at any time, toggle scrub-on-exit, run fully offline, and delete all local data by removing the installation.
- For purchase data: to access, correct, or delete the limited personal information associated with your order, contact legal@squishycode.ai; we will also direct you to Lemon Squeezy where it is the controller or processor of that data. Depending on your jurisdiction (e.g. GDPR or CCPA), you may have additional rights regarding personal data held in connection with your purchase. [Confirm scope of statutory rights language with counsel.]

---

11. Changes to This Policy

We may update this policy as the product or our processes change. We will post the updated version with a new effective date. Material changes will be reflected on our website.

---

12. Contact

Squishy Code AI LLC
732 S 6th St, Ste N
Las Vegas, NV 89101
Privacy and legal notices: legal@squishycode.ai
General and support: contact@squishycode.ai

---

This Privacy Policy should be read together with the Vek-Snap End User License Agreement (`EULA.md`) and the source-code license (`LICENSE`, PolyForm Noncommercial 1.0.0).
