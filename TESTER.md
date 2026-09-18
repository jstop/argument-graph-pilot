# For the two testers: your phones, one claim, one attack

Thank you for trying this. It takes about twenty minutes. There are two
of you; this page calls you **A** and **B**. Each of you installs a
wallet app on your own phone and receives a membership credential. Then
A posts a claim on a website, B attacks it, and you both watch A's
number go down. Nothing about your identity is collected; the wallet
makes up a new identifier for you, and you appear under a handle (a
short name) that you choose.

If anything on this page does not match what you see, keep going if you
can, and write down what the screen actually said. That is exactly the
feedback we want.

Each of you needs: your phone, a second screen for the website (a
computer or tablet; the phone has to scan a code shown on it), and the
address of the **argument site**, https://claims.<domain>/. The person
who runs the pilot (the operator) has a second page,
https://issuer.<domain>/, and shows you two codes from it.

## 1. Both of you: install the wallet and get your credential (10 minutes)

### Install

1. Install **Veridian Wallet** from the App Store or Google Play (the
   publisher is the Cardano Foundation). Open it.
2. Create a PIN when asked. If it offers fingerprint or face unlock, do
   what you prefer.
3. It shows you a **recovery phrase** (a list of words) and asks you to
   confirm it. Write the words down; you can throw the paper away after
   today. The words are the only backup of your wallet.
4. You reach a screen called **Connect to Veridian**. Tap the button to
   get connected, then **Proceed to scan**.
5. Ask the operator for the **onboarding QR code**. (For the operator:
   it is on https://issuer.<domain>/, top of the page, inside the
   collapsed line "First time with this wallet? Onboarding QR"; click
   the line to expand it.) Scan it. The app connects to our server.
   This can take up to a minute.

   If scanning does not work, tap **Advanced setup** and type the two
   addresses the operator gives you (a "boot URL" and a "connect URL").

6. The app asks whether you want an **Individual** or **Group**
   profile. Choose **Individual**. Give it any name. This is the
   identity you use today. It is created on your phone; we never see
   the keys behind it.

   If the app shows **"Misconfigured cloud agent"** here, tell the
   operator; it means our server is not telling the app about its
   witnesses. Tap **Check again** after it is fixed.

### Receive your membership credential

1. Tell the operator the handle you want to appear under (up to 40
   characters; accents are fine). The operator types it and the page
   shows a QR code. Whoever scans it first gets the credential, so scan
   only the one made for you.
2. In the wallet, go to **Home**, tap the **Add connection** tile
   ("Establish a new connection"), then tap **Scan** and scan the code.
   (The "Scan to login" tile is something else and says *Coming soon*.)
   The code is valid for 15 minutes; if it has expired the operator
   makes a new one.
3. Within a few seconds, in the wallet's **Notifications** tab:
   **"Community Issuer wants to issue you a credential"** (the first
   words are the issuer's name and may differ). Open it and tap
   **Accept**.
4. Open the **Credentials** tab. You should see a **Community
   Membership** credential. The only thing it says about you is your
   handle.

The operator's page says **Accepted. The credential is in the wallet**.

## 2. A posts a claim, B attacks it (10 minutes)

### A: post a claim

1. On your second screen, open https://claims.<domain>/ and tap **Post
   a claim**. A page with a QR code appears.
2. In the wallet: **Home → Add connection → Scan**, and scan it.
3. First time only: in the wallet's **Notifications** tab, **"Argument
   Log has requested a credential from you"** (the first words are the
   site's name and may differ). Open it, pick your Community Membership
   credential, and confirm.
4. The website's status changes to **You are a member (your handle)**,
   with a list of what was checked, and a text box appears.
5. Type your claim: one or two sentences that someone could disagree
   with. Any language. **Accents and emoji are welcome**; we want to
   know how your phone shows them. Tap **Send to my phone to sign**.
6. In **Notifications**, open the one that starts **"Signing
   request"**. It shows several lines: the kind of entry, your text,
   and some long codes. **The phone shows only the beginning of a long
   text, on one line.** That is how the wallet behaves and we cannot
   change it; what you sign is the whole text as the website shows it.
   Please note down what the phone showed (where it cut the text, and
   whether accents and emoji looked right).
7. Tap **Sign** and confirm with your PIN, fingerprint or face. (Tap
   **Don't allow** if the text is not yours.)
8. The website says **Written to the log**. Tap **the argument**. Your
   claim is there under your handle, with the number **0.5000**. Every
   new entry starts at that number.

### B: attack A's claim

1. On your second screen, open https://claims.<domain>/, find A's claim
   and tap **Attack** under it.
2. Do the same steps as A, 2 to 7. The text box asks "Why is the entry
   above wrong?" Write your reason.
3. The website says **Written to the log**. Tap **the argument**.

### Both of you: look at the result

1. Reload https://claims.<domain>/ (the page does not refresh itself).
   A's claim now shows **0.2500**. B's attack sits under it, with its
   own number, 0.5000. A's claim has not been removed or hidden.
2. Each of you: under your own entry, tap **signed entry, and how the
   number was computed**. You see your text, the sum that produced the
   number, the identifier that stands for you, what your phone showed
   you, and the event your phone signed.
3. Optional: post a second entry (A can tap **Support** on the claim,
   or **Attack** on B's attack). If you are still on the page that says
   "Written to the log", the text box is there again and you only have
   to **Sign**. From the front page you scan again, but the wallet
   should **not** ask you to share your credential a second time. Tell
   us if it does, and tell us what the wallet says when you scan the
   site a second time; we have not seen that screen.

That is the whole test. Neither of you created an account or logged in
anywhere.

## 3. For a third person (no phone)

You need a computer with git and Python 3.12, and the issuer's
identifier, given to you by the operator directly (not copied from the
site). The page https://claims.<domain>/verify shows these commands with
the addresses filled in:

```
git clone <this repository> && cd <it>/verifier
python3.12 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
curl -o export.json https://claims.<domain>/export.json
python -m arglog_verifier export.json --issuer <issuer identifier>
```

1. Compare the report with the site: same entries, same handles, same
   numbers (A's claim `0.2500  (exactly 1/4)`), and the last line
   `RESULT: every check passed`.
2. Open `export.json` in a text editor, change one letter of A's claim
   text, save, and run the last command again. Tell us which line now
   says `FAIL` and what the last line says.

## Afterwards

- You can delete the app. Nothing we hold can be used without your
  phone.
- What you posted stays on the site. Entries cannot be deleted; that is
  part of what is being tested.
- If you keep the app, the credential stays valid until we revoke it.

## Tell us

- Where the wording above did not match the screen.
- What the signing screen showed of your text: where it was cut, and
  how accents and emoji looked.
- Whether the wallet asked for your credential more than once.
- Anywhere you had to wait more than a minute.
- Anything that felt confusing, especially in the wallet's own screens,
  which we cannot change.
- Third person: whether the commands worked as written, and whether the
  report matched the site.

---

*For us, not the tester: this page was written from the wallet's source
(v1.2.0) and demo2's corrected phone run (2026-09-18: the "Individual"
profile step, the "Misconfigured cloud agent" note, the scanner being
Home → Add connection → Scan, the onboarding QR location). It has NOT
yet been executed on a phone for this pilot. Not established from our
source and therefore hedged above: the exact text of the signing
notification after the words "Signing request", what the wallet shows
when a known site's QR is scanned a second time, and how the signing
screen renders non-ASCII text.*
