# **Practical assessment — bilingual WhatsApp \+ voice assistant for KSA automotive retail**

**Issued** 9 September 2026  |  **Timebox** 5 working days (\~20–25 hours)  |  **Closes with** a 45-minute live demo  
You are being asked to build, on AgenticFlow, the thing a real Saudi automotive client asked us to build. The brief below is the brief we were given, with the client’s name removed and one addition: you pick the brand.  
**Read this once end to end before you start.** The hard parts are not where they look.

## ---

**The reference process**

This is the outbound process as it runs for the client this exercise is modelled on. It is not a specification of your build — it is the shape of the thing, so you can see where the branches are before you read the requirements.

### **The sequence**

| \# | Who | Step |
| :---- | :---- | :---- |
| 1 | Company site | **Request a call** is submitted on the vehicle page |
| 2 | Assistant | **WhatsApp opens**: continue here, or take a call? |
| 3 | Assistant | **Confirm the request** — the vehicle they enquired about, and where the enquiry came from |
| 4 | Assistant | **Confirm the payment method** — cash, finance or lease |
| 5 | Assistant | **Capture colour preferences** — 1st, 2nd and 3rd choice |
| 6 | Assistant | **Offer to raise the order** — the gate everything after it depends on |
| 7 | Assistant | **Offer accessories and protection** — tint, PPF, nano coating. Only after the order is accepted |
| 8 | Assistant | **Mention the active campaign offer**, if the brand is running one |
| 9 | Assistant | **Close** — submit the lead as HOT or COLD with the call details, and send the final WhatsApp message |
| — | Store | Every step writes its answers as it goes — not one write at the end |

### **The branch points**

| At | Condition | Goes to |
| :---- | :---- | :---- |
| **Channel preference** (after step 2\) | Continue on chat | Step 3, on WhatsApp |
| **Channel preference** | Prefers a call | Ask now or a preferred time, then step 3 on the call |
| **Channel preference** | **No reply** | Schedule a follow-up, then re-attempt the opening |
| **Order?** (after step 6\) | Yes | Step 7 — accessories |
| **Order?** | No | Thank them, final WhatsApp message, submit as **COLD** |
| **Payment × timing** (after step 7\) | Cash, buying now | Campaign offer, then a buying-preference choice — a fully online purchase, or telesales. Submit as **HOT** |
| **Payment × timing** | Lease, buying now | Campaign offer, then submit as **HOT** |
| **Payment × timing** | Cash or lease, **buying in over a month** | Thank them, final WhatsApp message, submit as **COLD** |

*The visual swimlane version of this flow is in the web copy of this brief, where it scrolls at full size.*

### **Reproduce this**

> * The submission, and a deliberate delay before the assistant opens.  
> * The channel choice, and the **no-reply follow-up** — a customer who never answers the first message is the common case.  
> * The qualification sequence **in this order**. It encodes a sales decision: the order offer comes *before* accessories, so nothing is up-sold to someone who hasn’t said yes.  
> * The order gate, and the routing on **payment method × timing**.  
> * A HOT or COLD outcome, with the call details attached.  
> * The final WhatsApp message on every terminating path.  
> * A store that each step writes to as it goes — not one write at the end.

### **Context only — don’t build it**

> * The **campaign offer**. If your chosen brand is running one, mention it; if not, skip the step.  
> * The **fully-online vs telesales** split and the UTM-tracked purchase link. That is one client’s e-commerce estate.  
> * A real **CRM**. Writing HOT or COLD to your own store, with the call details, is the whole requirement.

Section 8 governs: depth beats breadth. A diagram box is not a licence to build an integration.

### **What the process diagram doesn’t show**

> * **Language.** Nothing in it says which language any of it happens in. That decision has to be made before the first message and again before any call — requirement C.  
> * **The channel change.** The two paths out of the channel choice look parallel. They are not: a customer can cross between them mid-qualification, and the sequence must survive it — requirement D.  
> * **The platform.** The first step and the last one are both WhatsApp sends, and neither is free-form — requirements E and F.  
> * **Time.** Every step that needs a price is a round-trip the customer is listening to — requirement G.

## ---

**1 · The scenario**

A customer is on a car brand’s Saudi website, on the page for a specific model. They fill in a short **“Request a call”** form and submit it. That submission is the **only** thing you are given:

| Field | Example | Notes |
| :---- | :---- | :---- |
| fullName | محمد العتيبي / Mohammed Alotaibi | May be Arabic or Latin script |
| mobileE164 | \+9665XXXXXXXX | Already normalised |
| vehicle | Car model name | Pre-filled from the page they were on |
| language | Arabic | English | What they picked on the form |
| consentWhatsapp | true | false | Explicit checkbox |
| submittedAt | ISO 8601, UTC | Server-side |

Nothing else. No budget, no timeline, no payment method, no colour, no accessories, no trade-in. **Everything else is earned in conversation.**

| From that moment, the assistant opens. The customer never contacts you first — they asked to be called, so the first move is always yours, on whichever channel you can legally use. |
| :---- |

### **What the assistant is for**

Qualify the lead well enough that a human sales advisor can pick up the phone and sell: which vehicle, which grade, which colours (ranked), cash or finance, roughly when, which accessories they want, and whether they will let us raise the order now. Then hand it over with a written record.

## **2 · What you must build**

Eight requirements. Each one is judged on the demo, not on the description.

### **A · A real catalogue, scraped from a real website**

Choose **one** automotive brand or distributor with a Saudi (KSA) website that publishes prices. Extract, structure and serve:

> * **Models** — at least **3**  
> * **Grades / trims** per model — at least **2** each, with the **retail price in SAR**  
> * **Colours available per grade** — because they differ per grade, and that matters in the conversation  
> * **Accessories** — at least **6**, with prices where published

**Rules**

> * **Real published data.** Not invented, not “approximately”, not a representative sample you typed by hand.  
> * **The extraction has to be repeatable.** A script we can run, or a documented procedure plus the raw captured pages. A one-off copy-paste into a spreadsheet does not qualify.  
> * **Respect the site.** Check robots.txt, rate-limit yourself, identify your agent. One polite pass to build a catalogue for a demo is fine; hammering a production site is not, and we will look at how you did it.  
> * **If the site does not publish something** — accessory prices are commonly missing — say so in writing, and mark the placeholder as a placeholder *inside the data*. Silently inventing a number is the single worst thing you can do on this exercise.  
> * **The brand you pick is yours to defend.** Pick one whose site actually publishes grade-level prices. Discovering on day 4 that your brand publishes “starting from” prices only is a planning failure, not bad luck.

| Excluded: Toyota / Abdul Latif Jameel. That is the build this exercise is modelled on, and our own catalogue is public in places. Pick anything else. |
| :---- |

### **B · Two channels, and the customer chooses**

The customer asked for a call. Some of them, once you reach them, would rather type. Both paths have to work:

> 1. **WhatsApp** — the assistant qualifies them in chat.  
> 2. **Voice** — the assistant places an **outbound call** and qualifies them by phone.

The customer must be able to choose, and the choice must be honoured. A customer who chose “call” and is qualified by text instead has been ignored.  
**Calling hours:** 09:00–21:00 Asia/Riyadh. A request that arrives at 02:00 is not a call at 02:00. Decide what happens instead and build it.  
**A call that isn’t answered** is the common case, not the edge case. Decide what happens and build that too.

### **C · Three ways the customer will write and speak**

| Mode | Channel | Requirement |
| :---- | :---- | :---- |
| **English** | WhatsApp \+ voice | Natural business English. No Arabic words sprinkled in. |
| **Najdi Arabic** | WhatsApp \+ voice | See below. This is the one they notice first. |
| **Arabizi** | WhatsApp only | Arabic typed in Latin letters with digits for letters: abgha camry, wesh al-as3ar, 3ndkom prado 2026 in white or black? |

| Arabic means Riyadh Najdi. Not Modern Standard Arabic. Not Egyptian, not Levantine, not generic Gulf. A grammatically perfect MSA reply is a failed reply, however correct and however helpful. |
| :---- |

That is the first thing a Saudi reviewer reacts to, and it is what gets these projects rejected. The standard.  
Register: **colloquial but professional** — a Riyadh showroom advisor speaking to a customer she met five minutes ago. Not formal MSA, and not street.

| We hold a written Najdi gate — a required-token list and an MSA ban-list — and we will run your Arabic output against it at the demo. We are not sending it to you. Building your own equivalent, and enforcing it before a message is sent, is part of the task. |
| :---- |

On the **Arabic call**, the same standard applies to what the customer *hears*. Text that reads as Najdi can still come out sounding wrong. Voice and dialect configuration is part of the job, not an afterthought to the prompt.  
**Two things worth knowing before you spend time on them**

> * **Arabizi is text-only.** Don’t build anything for it on the voice side.  
> * **Code-switching is normal and must not flip the language.** Saudi customers say automatic, sunroof, hybrid, grade inside an Arabic sentence. “abi sayara automatic for my wife” is an **Arabic** customer. Get this wrong in the confident direction and you lock an Arabic speaker into English for the rest of their life on your system, because Latin text has no easy way back.

### **D · One conversation across two channels**

| Anything the customer tells either assistant, and which you save, must be known to the other assistant. The customer never repeats themselves. |
| :---- |

Concretely, both of these must hold at the demo:

> * Answers given on WhatsApp are known to the call. The call does not re-ask them.  
> * Answers given on the call are known to WhatsApp. WhatsApp does not re-ask them.

This includes an answer the customer **declined** to give. “I’d rather not say what I earn” is information. Asking again on the next channel is the failure this requirement exists to prevent.  
Design this as **coverage over every field you persist**, not as a list of fields you remembered to forward. Convince yourself it holds by measuring it, not by trying it once.

### **E · WhatsApp templates and the messaging window**

You are initiating contact, so you are subject to the platform rules. This is mechanical, unglamorous, and where most candidates lose the exercise.

> * **You cannot open a WhatsApp conversation with a free-form message.** The first message is an approved **template**.  
> * Templates are **submitted to Meta and reviewed**. Review takes time. If you start this on day 4 you will not have an approved template on day 5\. Submit on **day 1**.  
> * **Category matters.** Get the category and the copy right for what this actually is — a response to a request the customer made — and say in your notes why you categorised it the way you did.  
> * The **customer service window closes 24 hours after their last message.** After that, free-form sends fail. This has consequences in F that are easy to miss.

Deliver the exact template name, category, language, body, sample values and buttons for every template you use. If Meta review does not land inside the timebox, show the submission and demonstrate the send path with a sandbox template, and say clearly in your notes what was substituted.  
**Opt-out is global.** A customer who says لا تتصلون علي / “stop messaging me” has opted out of *both* channels, permanently. One suppression list, honoured by every send and every dial.

### **F · The closing summary, on WhatsApp, always**

When the qualification is finished, the customer gets a **summary on WhatsApp** of what was agreed: vehicle, grade, price quoted, colours, payment route, accessories, and what happens next.  
This holds **whether the conversation happened on WhatsApp or on the call.** A customer who was qualified entirely by phone still gets the written recap on WhatsApp, and it must contain what was said *on the call*.

| The summary must arrive. Re-read the last bullet of E and work out what that means for a call that happens two days after the customer’s last WhatsApp message. Then build for it. |
| :---- |

### **G · Latency — what the customer actually judges**

| On a call, silence is the product. |
| :---- |

A customer who stops speaking and hears nothing for three seconds has concluded something about your company before the assistant says a word. On WhatsApp the tolerance is longer, but past about ten seconds of nothing the customer assumes the bot is dead and texts again — and now you have two inbound messages, one half-finished turn, and a reply that answers the wrong one.  
**This is not a polish item.** It is decided by architecture, not by tuning at the end, and it is one of the requirements most likely to decide the outcome of this exercise.  
**The bar**

| Measure | Target |
| :---- | :---- |
| Voice — first word after the call connects | under **1.5 s** |
| Voice — response begins after the customer stops speaking | under **1.5 s** at p50, under **2.5 s** at p90 |
| Voice — any gap beyond \~3 s | must be covered by something audible |
| WhatsApp — a signal that the message landed | under **3 s** |
| WhatsApp — the reply | under **5 s** typical; nothing over 10 s unsignalled |

**Where the time goes, and the part that is yours**  
Every catalogue lookup is dead air. The customer asks what the top grade costs, and between their last word and your first there is a tool round-trip they are listening to. So:

> * **How many tool calls does a turn cost?** A turn needing three lookups is three round-trips unless you designed it not to be. Look at what one turn actually needs before you shape the tool.  
> * **How fast is the thing behind the tool?** Your catalogue endpoint’s own latency lands directly in the conversation. A 2-second lookup is a 2-second silence, every time, for every customer.  
> * **Tool call or knowledge-base retrieval?** Both can serve a catalogue, and they have different latency and different failure behaviour. Pick one deliberately and say in your notes why — including what you gave up.  
> * **Cover the gap.** Something has to occupy the silence while a tool runs. Be warned: **instructing the model in the prompt to say a filler is not reliable.** Some models emit no text at all before a function call, so the instruction produces nothing and no amount of prompt rewriting fixes it. Find the mechanism that does not depend on the model’s cooperation.  
> * **A filler longer than the gap makes it worse.** If lookups return in 0.7 s, a two-second “let me check that for you” has added a second of latency and a stilted beat to every turn. Measure the gap before you fill it.  
> * **And it must be in the language of the conversation.** A filler in the wrong language is worse than silence.

**The knobs that cost you on every single turn**

> * **Prompt length.** There is no practical cap, which means nothing will stop you writing a very long prompt — and you pay for its length on every turn of every conversation. Prompts grow: each new rule feels free and none of them are. Watch the number.  
> * **The model, and its reasoning budget.** A model that thinks before it answers is the wrong model for a voice turn. Reasoning effort, thinking budget and max-output-tokens are *latency* settings here, not quality settings.  
> * **Turn-taking.** How long the assistant waits before deciding the customer has finished speaking is a direct trade: too eager and it talks over them, too patient and you have added a beat to every turn of the call. It is tunable and we expect you to have tuned it.

**Measure it, and bring the numbers.** “It felt responsive” is not a measurement and we will not accept it. Bring per-turn timings: where the time went, p50 and p90, and the worst turn you saw. An engineer who can point at their slowest turn and say what it was waiting for is telling us something no demo can.

| One thing that will not be your fault. The platform has an intermittent stall that can add tens of seconds to a request, and it does not care which endpoint you called. It may well happen during your demo. We will not hold that against you — but we will hold it against you if you cannot tell it apart from your own code. Instrument well enough that you can say “that one was not me”, and show us why. That answer scores better than a demo where nothing went wrong. |
| :---- |

### **H · Evals — how you know it works, and how we re-check it**

Everything above is a claim about behaviour. **Build the thing that tests those claims, run it, and hand it to us runnable.** This is a requirement, not a deliverable-of-convenience, and it is the one that tells us whether you can hold a system like this in production rather than get it working once.  
**The lesson we paid for, given to you free**  
Our own build had **39 offline suites green** through a window in which we shipped real, customer-visible defects: a grade the customer asked to *compare* recorded as the grade she *chose*, a budget field overwritten with the price we quoted, an Arabic filler reaching the English assistant. Every one of those was **model behaviour**, and not one offline suite could see it.

| Assertions over your own flow code will stay green while the assistant is confidently wrong. If your eval suite only tests plumbing, it is telling you nothing about the product. |
| :---- |

**What your evals have to cover.** Take the claims this brief makes and make each one testable:

| Claim | The eval has to catch |
| :---- | :---- |
| Arabic is Najdi (**C**) | An MSA reply. Including on the turns that drift — refusals, finance, the closing summary |
| Arabizi is Arabic (**C**) | A Latin-script Arabic sentence answered in English, or a stored language preference flipped the wrong way |
| Every figure is grounded (**3**) | A price, grade, colour or accessory the assistant said that is not in the catalogue |
| The customer never repeats themselves (**D**) | A field answered — or declined — on one channel and re-asked on the other |
| One question per turn (**4**) | Two questions in one message; a turn that ends without one |
| The summary always arrives (**F**) | A completed conversation with no recap sent, in-window or out |
| Latency (**G**) | A p50 or p90 over target, and where the time went |

**How they have to be built**

> * **Runnable by us, in one command**, without you present. If it needs credentials, say which and how to supply them.  
> * **Deterministic where it can be, graded where it can’t.** Grounding and re-asking are checkable mechanically. Najdi register and conversational quality need a rubric and a judge.  
> * **If you use a model as the judge, you owe us its validation.** Label a set of cases yourself, run the judge against your labels, and report where it disagreed with you. An unvalidated judge is a number with no meaning behind it, and graders have their own bugs — ours did.  
> * **Fixtures, so a result means something over time.** Record real turns and replay them, so the same input gives a comparable answer after you change a prompt. Without this you cannot tell an improvement from a coincidence.  
> * **Every eval reports a number and a verdict**, not a wall of output. We want to see what passed, what failed, and what is not covered at all.  
> * **Say what your suite cannot see.** Every suite has a blind spot; ours was an entire category of defect. Knowing yours is worth more to us than a green run.

| At the demo we will run your evals in front of you. Then we will ask two questions: *which defect did this suite actually catch during the week?* and *what would get past it?* A suite that has never failed has never been tested. If it went green on the first run and stayed green, tell us — and tell us what you did about that. |
| :---- |

## **3 · Grounding: every figure comes from the catalogue**

Non-negotiable, and the fastest way to fail:

| Every price, grade name, colour and accessory the assistant says must be traceable to your catalogue data at the moment it was said. |
| :---- |

Not remembered from the prompt. Not paraphrased. Not “the Camry starts around 115,000”. If the assistant says a number, you must be able to show us where that number came from.  
**Two corollaries to design for rather than discover**

> * A model’s price list in a prompt is stale the day the site changes it, and a language model reciting numbers from its context will eventually recite one that isn’t there. Serve the catalogue in a way that makes that structurally hard.  
> * **When the catalogue doesn’t have the answer, the assistant says so and keeps the conversation moving.** “I don’t have that” is a good answer.

| An invented figure is a fabricated commercial commitment to a real customer, and in this market it is the kind of mistake that ends a contract. There is no partial credit here. |
| :---- |

## **4 · Conversation quality**

The client’s actual praise for the production system was about how it reads. These are the rules that produced that, and we score against them:

> * **One question per turn.** Never two. Never a question stacked onto a clarification.  
> * **Answer before you ask.** If they asked something, answer it, then ask your next thing.  
> * **Never ask the same thing twice** — across channels, not just within one.  
> * **Every turn ends with the assistant’s own next question.** The conversation never stalls waiting for the customer to drive it.  
> * **No dead ends.** Whatever the customer says — off-topic, hostile, confused, a question about something you don’t sell — there is a way forward.  
> * **Never narrate the plumbing.** The assistant does not say “let me save that”, “I’m checking the system”, “one moment while I look that up”, “transferring you now”. The customer is talking to an advisor, not watching a workflow.  
> * **No filler, no compliments, no reacting to money.** A customer who tells you their salary gets their next question, not “that’s great\!”.  
> * **First price gets a caveat, once.** Prices are preliminary; the advisor confirms. Say it before the first figure, in the language of the conversation, then quote bare.

**Also handle — they will come up at the demo**

> * **Arabic-Indic digits** in the customer’s input (١٢٠٠٠).  
> * **Numbers on a call** need to be *spoken*, not rendered as digits and markdown.  
> * **Gender.** Read it from the name where you can and hold that form for the whole conversation. Where you genuinely cannot tell, don’t guess.

## **5 · What you hand in**

> 1. **A working system on AgenticFlow** we can trigger live at the demo.  
> 2. **The trigger.** A form page is optional — it is not what we are assessing. A documented POST payload and a way to fire it is required.  
> 3. **The catalogue** — the structured data, plus the scraper or the documented extraction procedure and raw captures.  
> 4. **Flow exports and prompts**, as files. Versioned, so we can see what changed. Prompts in the export must be the prompts that are live.  
> 5. **Templates** — names, categories, languages, bodies, sample values, buttons, and their approval state.  
> 6. **The eval suite** — see H. Runnable by us in one command, its fixtures, and the output of its last run. If you used a model as a judge, include the validation.  
> 7. **Latency measurements.** Per-turn timings against the targets in G, with p50, p90 and the worst turn, and a note on where the time went.  
> 8. **A written note, 2–4 pages.** What you built, the decisions you made and why, what the platform made hard, **what is not finished, and what you know is broken.** This is read closely.  
> 9. **No credentials in anything you hand over.** API keys, tokens, WABA secrets — none of them, anywhere, including in a flow export.

## **6 · The demo**

45 minutes. We trigger it, you drive. We will run scenarios from these categories — expect all of them, in some order:

> 1. The English path, start to finish.  
> 2. The Najdi Arabic path, start to finish.  
> 3. A customer who opens in **arabizi**.  
> 4. A customer who **starts on WhatsApp and moves to the call** mid-qualification.  
> 5. A customer who is **qualified on the call** and then gets the WhatsApp summary.  
> 6. A call that **isn’t answered**.  
> 7. A customer who **refuses** to answer one of your questions.  
> 8. A question your catalogue **cannot answer**.  
> 9. A customer who **opts out**.  
> 10. A request that arrives **outside calling hours**.  
> 11. A summary that has to reach a customer whose **messaging window has closed**.  
> 12. A turn that needs **two catalogue lookups** — we will listen to what happens in between.  
> 13. A **cold start** — the very first turn, with nothing warm.  
> 14. **Your eval suite, run in front of us.**

We will read your Arabic against our gate, we will ask where any figure you quoted came from, we will ask you for your latency numbers, and we will ask what your evals would let through.

| Broken is fine. Claiming it works when it doesn’t is not. If something is half-built, tell us at the start of the demo. We have far more time for an engineer who says “6 and 11 are not done, here’s why” than for one who improvises around them and hopes we don’t run them. |
| :---- |

## **7 · How you are scored**

Weighted at the demo, from what we see run.

| Weight | Dimension |
| :---- | :---- |
| **18** | **Najdi Arabic** — dialect, register, consistency, and an enforced gate rather than hope |
| **16** | **Catalogue fidelity and grounding** — real data, repeatable extraction, every figure traceable, honest about gaps |
| **14** | **Latency and responsiveness** — the targets in G, the tool and retrieval architecture behind them, and measurements you can show |
| **12** | **Evals** — coverage of the claims in this brief, a validated judge where one is needed, fixtures, and an honest account of the blind spots |
| **11** | **Cross-channel context** — coverage, including declined answers; measured, not assumed |
| **11** | **Platform mechanics** — templates, category, the 24-hour window, outbound initiation, calling hours, global opt-out |
| **7** | **Conversation design** — section 4, judged on transcripts |
| **6** | **The closing summary** — arrives on WhatsApp regardless of channel or window |
| **5** | **Engineering hygiene** — versioned, credential-clean, and an honest gap list |

### **What sinks it regardless of the rest**

| A price, grade or accessory the assistant said that isn’t in the catalogue. Any. Arabic that is MSA. Re-asking something the customer already answered on the other channel. A message sent to someone who opted out. “It works” about something that doesn’t, when we run it. Credentials in the handover. A scrape that abused the site — ignored robots.txt, no rate limit. Repeated unexplained dead air on a call, with nothing covering it. No latency instrumentation at all — you cannot tell your own slowness from the platform’s. An eval suite that only tests your own plumbing and would stay green through every defect this brief warns about. A model judge with no validation, presented as a score. |
| :---- |

### **What marks a strong candidate**

> * Finds a platform constraint we didn’t mention, and designs around it instead of fighting it.  
> * Treats context parity as a measurable property and shows us the measurement.  
> * Notices that the Arabic *voice* has a configuration layer of its own, and goes looking for it.  
> * Shapes the catalogue tool around **what one conversational turn needs**, rather than mirroring the website’s structure and paying for it in round-trips.  
> * Can name a defect their **own eval suite caught** during the week, and show the eval that caught it.  
> * Comes to the demo with a shorter feature list and a longer list of things they verified.  
> * Their written note tells us something about the problem we didn’t already know.

## **8 · Out of scope — do not spend time here**

> * CRM design, dashboards, reporting, analytics.  
> * Lead deduplication, ownership routing, SLA timers, sales-cadence automation.  
> * A designed website or a styled form.  
> * Payment, financing decisions, credit checks, real bank integrations.  
> * Multi-tenant anything, authentication, user management.  
> * A load test. G is about the latency one customer feels, not throughput.  
> * CI, containers, or deployment automation. H asks for evals that run, not a pipeline that runs them.  
> * More than 3 models. **Depth beats breadth here** — one model handled properly is worth more than eleven listed.

## **9 · Logistics**

> * **Access.** An AgenticFlow workspace, an assistant, WhatsApp sending, and outbound calling will be provisioned for you. Test numbers may be non-Saudi — that is normal for a sandbox and is not something you need to solve or flag.  
> * **Every WhatsApp send and every call reaches a real phone.** Send to your own number only. There is no dry-run channel.  
> * **Questions are welcome and are not penalised.** Ask about anything ambiguous in this brief, anything you can’t find in the platform docs, and anything where two readings would lead to two different builds. Asking three good questions on day 1 reads better than five days of guessing. What *is* penalised is a question that the brief already answers.  
> * **Timebox.** 5 working days from access. If you run out of time, hand in what runs, and put the rest in the gap list.

## **10 · Why we ask for this specific thing**

Because it is the shape of every deployment we do in this market, and because the parts that look easy are not the parts that fail.  
The catalogue looks like the hard part. It isn’t — it’s a day. The parts that take the other four days are: Arabic that a Saudi customer accepts, a conversation that doesn’t ask the same question twice when it changes channel, a platform that will not let you say what you want when you want to someone who asked you to call them, an assistant that answers fast enough that a customer on a phone call believes there is somebody there, and a way to know all of that is still true tomorrow.  
The last two are where most of these builds fail, and they are the two that cannot be added at the end.  
**An engineer who can hold all of it at once is who we are looking for.**