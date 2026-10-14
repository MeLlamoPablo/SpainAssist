# AI Act, GDPR and liability for SpainAssist: research memo

Date: 2026-10-14. Context: [SPEC.md](../../SPEC.md) ("Privacy"), D10 (LiteLLM gateway), D12 (scan
screening), D16 (MIT licence). Scope: what the law actually requires of us for sending users' data
to hosted LLMs, whether we must route through the EU or redact all PII, and what the MIT licence
does for the author's liability.

**Trigger.** A thread on X ([1](https://x.com/alonso_Isidoro/status/2110072387391959170),
[2](https://x.com/alonso_Isidoro/status/2110077143505883157)) replying to "voucher users only get
zero-data-retention providers". It claims that:
- ZDR only means "not used for training";
- data still leaves the EU and is decrypted on provider servers;
- data is kept "at least 30 days, unencrypted" in caches on several machines;
- only private on-prem EU servers with at-rest encryption are acceptable;
- "Brussels will investigate" us.

**How this was checked.** Web research on primary sources: EUR-Lex, Commission and EDPB guidance,
the AEPD, the BOE, and the provider docs of OpenRouter, Anthropic, OpenAI and Google. Plus a
reading of our own config (`infra/terraform/litellm.tf`, D10, D12,
`apps/desktop/src/main/phone/transcriber.ts`). Points that rest only on secondary sources are
marked **[secondary]**. This is research, not legal advice; the open questions at the end need a
Spanish lawyer.

## Summary

1. **Neither the AI Act nor GDPR requires EU data residency, on-prem inference, or redacting all
   PII before a model sees it.** Full redaction would hurt the agent and is not needed.
2. **The critic's "30 days unencrypted" is wrong for ZDR.** It describes the *default* (non-ZDR)
   abuse-monitoring retention of Anthropic and OpenAI. Decryption in memory for inference is true
   of every LLM, on-prem included.
3. **AI Act:** we are the *provider* of a limited- or minimal-risk AI system, not high-risk. The
   duty that matters is **Art. 50 transparency**: users must know they deal with an AI agent.
4. **GDPR is the real framework, and our gap is paperwork, not architecture.** For voucher users
   we are the **controller**: our LiteLLM gateway forwards their prompts and we choose the
   providers. That LiteLLM stores nothing does not change the role; it only lowers the risk.
5. **EU routing on OpenRouter is optional.** It is a nice selling point that lowers transfer risk.
   It needs the Business plan (fee 8% instead of 5.5%; models at list price). It is not "10% more".
6. **MIT and free distribution** keep us out of the new Product Liability Directive and the Cyber
   Resilience Act while we stay non-commercial. They do not cover GDPR duties for our servers,
   our own negligence or misleading claims, or intent. We are not normally liable for how users
   use the tool.

## 1. The X thread, claim by claim

| Claim | Verdict |
| --- | --- |
| ZDR data is kept 30+ days, unencrypted | **Wrong.** 30 days is the *default* retention for abuse monitoring at Anthropic and OpenAI. Under ZDR, Anthropic "does not store customer prompts or responses at rest after the API response is returned". OpenRouter stores no prompts by default; ZDR routing only goes to providers that keep nothing. Caches are in memory, for minutes up to 24 h (OpenAI prompt cache ≤ 24 h, Vertex ≤ 24 h). Nothing we found says retained data is "unencrypted". |
| Data is decrypted on provider servers | **True, and unavoidable.** Any LLM, on-prem included, must decrypt the input to run it. |
| Data leaves the EU | **True** for US providers. It is lawful under GDPR Chapter V with SCCs or the EU-US Data Privacy Framework (section 4). |
| Only on-prem EU servers are acceptable | **Not a legal requirement.** The AEPD's "prefer controlled systems" is an internal policy for its own staff, not binding guidance. |
| "Brussels will investigate" | **Wrong venue and wrong reason.** The AEPD (Spain) enforces GDPR, on complaints and risk. Missing GDPR paperwork is our real exposure, not the choice of ZDR providers. |
| "Anonymised transit encryption" | Not a real concept. |

**Where the critic has a point.** "Tu proveedor de IA no los guarda" (onboarding, voucher users)
is a public claim we must be able to back. Caveats:
- Anthropic's ZDR excludes some features (code execution) and some models (Fable/Mythos 5.x).
  Check `LITELLM_KEY_MODELS` against Anthropic's list.
- Confirm that ZDR also covers the screening route (D12: OpenRouter Decisions API via LiteLLM
  pass-through). Phone-call transcription already sends `provider: { zdr: true,
  data_collection: 'deny' }`.

## 2. AI Act (Regulation (EU) 2024/1689)

- **Our role.** Provider of an AI system (Art. 3(3): "whether for payment or free of charge"). We
  are also a downstream provider (Art. 3(68)), because we integrate someone else's model. We are
  **not** a general-purpose model provider: we train and modify no model.
  - Users acting for themselves have no deployer duties (Art. 2(10)).
  - A gestoría using the app for clients would be a deployer.
- **Risk class: not high-risk.**
  - Annex III 5(a) (public assistance benefits) and 7 (asylum, visas, residence) cover systems
    used *by or on behalf of public authorities* to decide.
  - SpainAssist helps citizens apply and decides nothing.
  - Not Annex I, and not biometrics (signing with a certificate or the DNIe is not biometric
    identification).
  - This changes if we sell to authorities, or add eligibility scoring for a public body.
- **Open-source exemption (Art. 2(12)) barely helps.** It never covers Art. 5 or Art. 50, and a
  system that interacts with people "falls under Article 50". Read strictly, that removes the
  whole exemption. Monetisation (recital 103: a price, paid services through a platform, or
  personal data used beyond security and compatibility) removes it too.
  - A free, invite-only key server is probably not monetisation. Nobody has ruled on it.
- **What applies to us:**
  - **Art. 50(1), since 2 Aug 2026.** Users must clearly know they interact with an AI system.
    The Commission's Art. 50 guidelines (20 July 2026) say agents should also disclose on whose
    behalf they act.
  - **Art. 50(2).** Machine-readable marking of synthetic text. It may reach chat replies; the
    exceptions cover assistive editing and short outputs such as data labels, which arguably
    includes form-filled values. Unclear whether marking by the upstream model suffices. There
    is a transition to 2 Dec 2026 for systems already on the market **[secondary]**.
  - **Art. 4 AI literacy** (since Feb 2025). The Digital Omnibus softened it to "promote" literacy
    **[secondary]**.
- **Data location and PII: nothing.** Art. 2(7) leaves personal data to the GDPR. Art. 10(5)
  concerns bias correction in high-risk systems only.
- **Digital Omnibus on AI.** Adopted as Regulation (EU) 2026/1744, in force since late July 2026
  **[secondary]**. Moves Annex III high-risk to 2 Dec 2027 and Annex I to 2 Aug 2028. Art. 5,
  general-purpose model duties and the rest of Art. 50 are unchanged.
- **Spain.** AESIA is the market surveillance authority. The Organic Law on AI governance has
  been in the Cortes since May 2026 and is not yet enacted.

## 3. GDPR roles

### Voucher users (mode a): we are the controller

We decide the purpose (running the assistant) and the essential means: our LiteLLM gateway, the
OpenRouter account, ZDR, the model list and the US providers. That is a controller under the
facts-based test of EDPB Guidelines 07/2020. OpenRouter and the model providers are our
processors and sub-processors. Hetzner, which hosts the VM in Nuremberg, is a processor too.
- A natural person can be a controller.
- The household exemption (Art. 2(2)(c)) covers our users, not us. Recital 18 applies GDPR to
  those "which provide the means for processing personal data for such personal or household
  activities".
- Calling ourselves the users' processor is a weak argument: users don't choose the providers.

### "LiteLLM is only a proxy, it stores nothing"

Checked in `infra/terraform/litellm.tf`: `turn_off_message_logging = true`,
`store_prompts_in_spend_logs = false`, `LITELLM_LOG = "ERROR"`, no logging callbacks besides
pricing. So the claim is true, but it **does not change the role**:
- **"Processing" doesn't depend on storage.** Art. 4(2) includes collection, use, *disclosure by
  transmission* and making available. Forwarding a prompt in memory is processing.
- **The role follows who decides, not who stores.** Even if the app called OpenRouter directly
  with keys from our account, we would still pick the recipients.
- **GDPR has no "mere conduit" exemption.** That idea is the e-Commerce Directive's and DSA
  Art. 4's: liability for illegal content passed through by intermediaries. The DSA leaves GDPR
  untouched.
- **We can read the prompts.** TLS ends at our proxy, so prompts are plaintext in the VM's
  memory. That is what Art. 32 security covers.

It does help us: a breach exposes live traffic only, not a history. Rights requests are nearly
empty. The privacy notice and DPIA get simpler. It also answers the critic: our hop stores
nothing, runs in the EU, and the hop after it is ZDR.

**Leftover personal data on our side:**
- Coolify/Traefik access logs: IP addresses. Keep their retention short.
- LiteLLM spend logs: key, model, tokens and cost.
- The key server's voucher ↔ key link.
- The feedback and maps servers.

### "Sign in with ChatGPT", BYOK and local data (mode b)

- Users acting for themselves are household-exempt.
- OpenAI is the controller for its own service.
- A publisher whose software never sends it the data is generally not a controller. Recital 78
  only "encourages" producers of applications to design for privacy.
- Caveat: CJEU C‑683/21 says an entity can be a controller without touching the data if it
  determines purposes and means. That case concerned an authority that commissioned an app, not
  an open-source publisher.
- ChatGPT users still reach our gateway for scan screening (D12, subsidy key): that slice is
  mode (a).

## 4. International transfers

- **GDPR does not require EU residency.** Transfers need an adequacy decision (Art. 45) or SCCs
  (Art. 46).
- **The EU-US Data Privacy Framework is valid.** The General Court upheld it in *Latombe v
  Commission* (T‑553/23, 3 Sep 2025). An appeal, C‑703/25 P, is pending (likely 2027).
- **Rely on SCCs**, which survive a DPF annulment, plus a one-page transfer impact assessment.
  - OpenAI's DPA uses SCCs.
  - OpenRouter's privacy policy cites adequacy and SCCs.
  - Anthropic's DPA uses SCCs: not verified.
  - DPF certification of the three: not verified. Check <https://www.dataprivacyframework.gov/list>.

## 5. PII: is redaction required?

**No.** No article requires redaction before an LLM sees the data.
- Art. 5(1)(c) minimisation means "adequate, relevant and limited to what is necessary": send what
  the task needs.
- Arts. 25 and 32 name pseudonymisation as an *example* of a measure, weighed against risk.
  Pseudonymised data stays personal data anyway (recital 26).
- The EDPB's LLM risk report (Apr 2025) recommends PII filtering as a mitigation, not as a rule.
- The AEPD's generative-AI recommendations (Nov 2025, summary Jan 2026) are internal to the AEPD
  and don't mandate pseudonymisation.

What we do need:
- **Special categories (Art. 9).** Health, disability and similar data needs an Art. 9(2)
  condition; for us realistically explicit consent, asked in the app before such data reaches a
  model. It also tips us into needing a DPIA (Art. 35).
- **`@sa/pii` stays where it matters.** Feedback (SPEC: fully scrubbed) and outgoing search
  queries. Scrubbing agent context is good Art. 25 evidence where it doesn't hurt the agent; it
  is not an obligation.

## 6. EU routing on OpenRouter

- **How it works.** Send requests to `https://eu.openrouter.ai/api/v1` from a Business or
  Enterprise account. Business is self-serve. Requests are decrypted in the EU and routed only
  to EU endpoints. If no EU provider serves the model, the request fails instead of leaving the
  EU. Guardrails can force EU-only per key.
- **Cost.** The Business fee is 8% on credits instead of 5.5%. Inference stays at provider list
  price, with no regional surcharge found.
  - "10% more" is Anthropic's own price for US-only inference (`inference_geo: "us"`, 1.1×).
  - Anthropic has no EU option.
- **Limits.** Fewer models: providers include Azure, Mistral, Fireworks and Baseten; no
  Anthropic. Web search, web fetch, Batch, image generation and most PDF engines don't work on
  the EU domain.
- **Residual risk.** OpenRouter is a US company. Remote access from outside the EU can itself be
  a transfer (EDPB 05/2021), so EU routing lowers transfer risk but doesn't remove US
  jurisdiction.
- **Verdict.** Offer it as an option ("procesamiento solo en la UE"), not as a requirement.

## 7. Liability: MIT, open source and how people use the app

- **The MIT disclaimer has limits under Spanish law.**
  - Liability for intent can't be waived in advance (Código Civil art. 1102); probably not for
    gross negligence either.
  - Ordinary negligence remains, but art. 1103 lets courts moderate it; free supply weighs for us.
  - Anyone harmed who never accepted the licence can sue in tort (art. 1902).
  - Consumer law (TRLGDCU) applies only to traders, so mostly not to us while we are free.
- **Product Liability Directive (EU) 2024/2853.** Software is a product, but art. 2(2) excludes
  "free and open-source software developed or supplied outside the course of a commercial
  activity".
  - Recital 14: a price, or personal data used beyond security and compatibility, makes it
    commercial.
  - It covers products placed on the market after 9 Dec 2026; Spain had not transposed it as of
    Sep 2026.
  - Where it applies, liability can't be limited by contract.
  - Damage covered: death, injury, property and data loss; not pure financial loss such as a
    missed deadline.
- **Cyber Resilience Act (EU) 2024/2847.** Covers only products made available in a commercial
  activity; non-monetised FOSS is out (recitals 15 and 18). An individual can't be an
  open-source steward. Reporting duties from 11 Sep 2026, the rest from 11 Dec 2027.
  Out of scope today.
- **How users use the tool.** As publisher of a general-purpose tool we are not normally liable
  for users' own acts: fraud, using someone else's certificate, skipping review. Their own fault
  breaks causation.
- **Where we are exposed is our own conduct:**
  - inaccurate public claims ("zero retention", "official", "always correct");
  - negligence in the hosted services (leaked keys or data);
  - known defects left unfixed or unwarned, such as submitting without confirmation;
  - GDPR duties for our servers, which MIT doesn't touch.
- **Monetising changes the picture.** A price, paid tiers, ads or data-for-access bring in
  consumer law, the PLD and the CRA. Set up an SL first, and get insurance.

## 8. Checklist

GDPR, for the gateway, key server, feedback server and maps server:
1. Privacy notice (Arts. 13–14), on spainassist.es and in the app, in Spanish and English. It
   names us as controller and OpenRouter, the model providers, Hetzner and Mapbox as
   recipients. It covers US transfers under SCCs, "prompts are not stored by us" (metadata
   only), legal basis (Art. 6(1)(b)) and user rights.
2. Accept the DPAs (Art. 28) of OpenRouter, Hetzner and Mapbox.
3. One-page transfer impact assessment.
4. Explicit consent before special-category data reaches a model (Art. 9(2)(a)).
5. Record of processing (Art. 30) and a short DPIA (Art. 35). The record is mandatory despite
   our size because Art. 9 data is involved.
6. Breach procedure (72 h, Arts. 33–34) and a contact for rights requests.
7. Short retention for proxy access logs.

Technical:
1. Enforce ZDR on every gateway route, including the D12 screening route.
2. Exclude models outside Anthropic's ZDR from voucher keys.
3. Optional EU-only routing (section 6).

AI Act:
1. A clear "esto es un agente de IA que actúa en tu nombre" notice, in Spanish and English.
2. Decide on Art. 50(2) marking, or document why the exceptions apply.

Liability:
1. Terms of use for the hosted services: free, as-is, may stop, Spanish law.
2. In-app: the user reviews and confirms what is filed or signed; "not affiliated with the
   Administración".
3. Keep public claims to what contracts and config actually guarantee.
4. Add a `SECURITY.md` with a vulnerability contact.

## Open questions for a Spanish lawyer

- Whether we are a controller or, at a stretch, the users' processor for the gateway.
- Whether a free, invite-only key server (or donations) counts as "commercial activity" or
  "monetisation" (AI Act, PLD, CRA).
- Spain's transposition of the PLD, and whether gross negligence is treated like intent for a
  free supply.
- Art. 50(2) scope for form-filled text.
- LSSI duties (legal notice, cookies) for spainassist.es.

## Sources

- AI Act: <https://eur-lex.europa.eu/eli/reg/2024/1689/oj>
- Commission Art. 50 guidelines: <https://digital-strategy.ec.europa.eu/en/library/guidelines-transparency-obligations-providers-and-deployers-ai-systems>
- Commission guidelines on general-purpose model providers: <https://digital-strategy.ec.europa.eu/en/library/guidelines-scope-obligations-providers-general-purpose-ai-models-under-ai-act>
- Code of Practice on AI-generated content: <https://digital-strategy.ec.europa.eu/en/faqs/code-practice-transparency-ai-generated-content>
- AI Omnibus timeline **[secondary]**: <https://fpf.org/blog/the-ai-act-implementation-timeline-what-changes-under-the-ai-omnibus/>
- Spanish AI law bill: <https://finreg360.com/alerta/el-congreso-inicia-el-tramite-del-proyecto-de-ley-organica-para-el-buen-uso-y-la-gobernanza-de-la-inteligencia-artificial/>
- OpenRouter data collection: <https://openrouter.ai/docs/guides/privacy/data-collection>
- OpenRouter ZDR: <https://openrouter.ai/docs/features/zdr>
- OpenRouter in-region routing: <https://openrouter.ai/docs/guides/features/in-region-routing>
- OpenRouter pricing: <https://openrouter.ai/pricing>
- OpenRouter privacy policy: <https://openrouter.ai/privacy>
- Anthropic API data retention: <https://platform.claude.com/docs/en/manage-claude/api-and-data-retention>
- Anthropic data residency: <https://platform.claude.com/docs/en/manage-claude/data-residency>
- OpenAI, your data: <https://developers.openai.com/api/docs/guides/your-data>
- Vertex ZDR: <https://docs.cloud.google.com/vertex-ai/generative-ai/docs/vertex-ai-zero-data-retention>
- AEPD generative AI summary: <https://www.aepd.es/guias/sumario-recomendaciones-iag-aepd.pdf>
- EDPB LLM risks report: <https://www.edpb.europa.eu/our-work-tools/our-documents/support-pool-experts-projects/ai-privacy-risks-mitigations-large_en>
- CJEU C‑683/21: <https://curia.europa.eu/jcms/jcms/p1_4259437/en>
- Latombe appeal (OJ): <https://eur-lex.europa.eu/eli/C/2025/6610/oj/eng>
- Código Civil: <https://www.boe.es/buscar/act.php?id=BOE-A-1889-4763>
- TRLGDCU: <https://www.boe.es/buscar/act.php?id=BOE-A-2007-20555>
- Product Liability Directive: <https://www.boe.es/buscar/doc.php?id=DOUE-L-2024-81701>
- PLD transposition status: <https://www.reedsmith.com/articles/eu-product-liability-directive-where-things-stand-with-member-state-transposition/>
- Cyber Resilience Act: <https://boe.es/doue/2024/2847/L00001-00081.pdf>
