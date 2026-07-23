# WebAZ Privacy Policy / 隐私政策

> Effective date: 2026-07-23
>
> Operator and publisher: **XU FENGNA (individual)**
>
> Contact: **contact@webaz.xyz**

This policy describes WebAZ and the WebAZ app submitted to OpenAI. It reflects current
implemented behavior and does not claim external legal review.

## 1. OpenAI app / OpenAI 应用

The submitted `shopping_v1` surface is anonymous and read-only and exposes only
`webaz_search`. It accepts product-search terms and filters, WebAZ recommendation anchors,
external product links or share text, cursors, and server-issued result handles with selected
product IDs.

It returns reviewed public physical-product information, including product identifiers and
public seller identifiers, names, and reputation summaries. It does not connect accounts,
access private account data, create orders, reserve stock, perform checkout or payment, or
expose KYC/KYB, rewards, disputes, or seller tools. Selecting a result opens WebAZ.

## 2. Data WebAZ handles / WebAZ 处理的数据

Depending on the feature used, WebAZ may process:

- Account, profile, contact, region, relationship, and interaction data.
- Passkey public credentials. Biometric data stays on the user's device.
- Saved and order-specific recipient, address, and phone data.
- Listings, orders, conversations, feedback, comments, support information, evidence, and
  dispute records.
- KYC/KYB and screening decisions for risk-gated seller or withdrawal capabilities.
- Wallet, ledger, deposit, withdrawal, collateral, commission, and other account-balance or
  transaction records, including simulated or non-custodial rail records where applicable.
- Coarse location coordinates when a user enables nearby features.
- Seller-provided receiving instructions, QR references, payment evidence, and push
  notification endpoints or keys.
- WebAZ authentication API keys, OAuth grants, delegated-agent permissions, connected-client
  metadata, and revocation or expiry records.
- Connection IP, browser user-agent, session, security, audit, rate-limit, and derived hash
  records. Active sessions may contain raw IP and user-agent values.

Ordinary anonymous catalog browsing does not require account, shipping, KYC, or payment data.

## 3. AI providers / AI 服务提供商

Feedback submissions are sent to Anthropic to draft an admin-reviewed response. When server
AI moderation is configured, sanitized comments may be sent to Anthropic for moderation.
Other AI-assisted features send the content needed for the request when the user invokes
them.

An administrator may invoke an Anthropic-assisted account-risk summary using account handle,
role, account age, order and GMV summaries, disputes, withdrawals, and negative-reputation
signals. This summary supports human review and does not itself make the final account
decision.

Browser-selected AI provider keys, endpoints, and model settings are stored in browser
storage; requests are sent directly from the browser to the selected provider. The WebAZ PWA
also stores its WebAZ authentication API key in browser storage, including IndexedDB, so the
signed-in browser can call WebAZ. Users should not submit or expose unnecessary personal,
confidential, authentication, or payment data.

The submitted `shopping_v1` tool does not itself invoke an AI provider.

## 4. Public information / 公开信息

Public product results may include product IDs and public seller identifiers, names, and
reputation summaries. Published dispute cases may include case, product, and seller
identifiers, redacted arguments and rulings, and nonanonymous commenters' identifiers,
handles, and names.

Automated redaction reduces disclosure risk but cannot guarantee removal of every identifier.
Users should not include unnecessary personal data in content intended for publication.

## 5. Purposes and protection / 处理目的与保护

WebAZ processes data to provide and secure its services, fulfill orders, prevent fraud and
abuse, operate scoped agent permissions, support users, and resolve disputes. Passkey
human-presence gates protect selected high-risk operations, including specified fund-moving,
privilege-changing, and other sensitive actions; not every profile or address update requires
a Passkey. Audit identifiers are hashed or anonymized where raw values are not needed.

## 6. Recipients / 数据接收方

WebAZ does not sell personal data or provide it to third parties for advertising.

- **Cloudflare** provides DNS, CDN, bot protection, and email routing.
- **Railway** hosts the application and database.
- **Resend** delivers verification and service email and processes the destination email
  address and message content needed for delivery.
- **Anthropic** and user-selected AI providers process the content described above.
- **Connected clients**, such as ChatGPT, receive tool inputs and results needed for the
  user's request under that client's own terms.
- **Order counterparties and fulfillment participants** receive the recipient, address,
  phone, and order information needed to fulfill an order in which they participate.
- Data may be disclosed when required by valid legal process, limited to what is required.

## 7. Retention and deletion / 留存与删除

WebAZ does not currently publish or implement one protocol-wide retention period. Records
remain until feature-specific deletion, deactivation, anonymization, or operational removal
occurs.

After an eligible account-deletion request reaches the implemented 14-day job, WebAZ
anonymizes selected profile fields and overwrites recipient, phone, and address-detail fields
in saved addresses. It also disables the account's password and API key, revokes active
sessions, delegated-agent grants, OAuth access and refresh tokens, pending authorization
codes, verification and recovery codes, and push subscriptions. It does not erase every
linked order, dispute, KYC, audit, security, or other record.

## 8. Access, correction, and requests / 访问、更正与请求

Authenticated users can obtain a JSON export containing bounded snapshots of listed account
categories; limits apply, and CSV export contains orders only. This is not a complete database
export. Users can edit supported profile and address fields in the app.

Requests concerning access, correction, deletion, or privacy may be sent to
**contact@webaz.xyz** and will be handled using available controls and applicable law.

## 9. Cookies, international use, and children / Cookie、跨境与未成年人

WebAZ uses session and authentication state and Cloudflare Turnstile. It does not use
third-party advertising or cross-site tracking cookies. Data may be processed where WebAZ and
its service providers operate. WebAZ is not directed to children below the age required by
applicable law.

## 10. Changes / 变更

Material changes will be published through WebAZ's notice process. Questions:
**contact@webaz.xyz**.

---

This policy must be updated when collection, sharing, AI processing, public output, retention,
or deletion behavior changes.
