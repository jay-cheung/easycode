import path from "node:path"
import { mkdir } from "node:fs/promises"

const root = path.resolve(import.meta.dir, "../..")

const repeat = (label: string, count: number) => Array.from({ length: count }, (_, index) => `${label} filler paragraph ${String(index + 1).padStart(3, "0")}. This sentence is deterministic and intentionally irrelevant.`).join("\n")

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const fixtures: Record<string, string> = {
  "evals/apix/fixtures/summary/name-allergy-50-turns.json": json({
    early_fact: { name: "林澈", allergy: "花生" },
    filler_turns: Array.from({ length: 50 }, (_, index) => `闲聊轮次 ${index + 1}`),
    final_task: "帮用户点一份晚餐，必须称呼姓名并避开过敏源。",
  }),
  "evals/apix/fixtures/summary/frontend-monitoring-architecture.md": [
    "# Frontend Monitoring Architecture",
    "Quality strategy buckets: 采集, 聚合, 报警, SLA, 降噪.",
    "采集: browser SDK captures JS errors, resource timing, API failures, and custom business events.",
    "聚合: events are grouped by page, release, user segment, and error fingerprint.",
    "报警: alerts trigger on burn rate, error budget, regression, and high-value customer impact.",
    "SLA: page availability, successful interaction rate, and recovery time are tracked per product surface.",
    "降噪: duplicate fingerprints, deploy windows, bot traffic, and known flaky networks are suppressed.",
    repeat("monitoring", 80),
  ].join("\n\n"),
  "evals/apix/fixtures/summary/location-nyc-london.json": json({
    timeline: [
      { turn: 5, fact: "current_location", value: "New York", timezone: "America/New_York" },
      { turn: 25, fact: "current_location", value: "London", timezone: "Europe/London" },
    ],
    rule: "Latest fact overrides older fact.",
    filler: repeat("location", 40),
  }),
  "evals/apix/fixtures/summary/blue-mug-location.json": json({
    weak_signal: "昨天刚买的蓝色杯子放在显示器旁",
    later_noise: repeat("mug", 35),
  }),
  "evals/apix/fixtures/summary/family-graph-10-people.json": json({
    people: ["Ada", "Ben", "Cora", "Dylan", "Eve", "Finn", "Gina", "Hank", "Iris", "Jules"],
    edges: [
      ["Ada", "parent", "Cora"],
      ["Ben", "parent", "Cora"],
      ["Cora", "sibling", "Dylan"],
      ["Dylan", "parent", "Eve"],
      ["Finn", "spouse", "Eve"],
      ["Gina", "parent", "Finn"],
      ["Hank", "parent", "Iris"],
      ["Iris", "spouse", "Jules"],
      ["Jules", "cousin", "Eve"],
    ],
    filler: repeat("family", 30),
  }),
  "evals/apix/fixtures/summary/brand-z-dislike.json": json({
    preference: "User strongly dislikes Brand Z and does not want it recommended.",
    acceptable_alternatives: ["Brand A", "Brand B", "Brand C"],
    filler: repeat("brand", 30),
  }),
  "evals/apix/fixtures/summary/five-stage-project.json": json({
    stages: [
      { id: 1, name: "需求确认", status: "done" },
      { id: 2, name: "方案设计", status: "done" },
      { id: 3, name: "实现", status: "done" },
      { id: 4, name: "验证", status: "done" },
      { id: 5, name: "发布复盘", status: "done" },
    ],
    final_instruction: "Close out with completed steps 1 to 5 preserved.",
    filler: repeat("project", 45),
  }),
  "evals/apix/fixtures/summary/incremental-rules.json": json({
    rules: ["输出中文", "包含编号", "不超过五句", "包含 DONE", "不要 Markdown 表格"],
    final_instruction: "All accumulated rules must be satisfied.",
    filler: repeat("rules", 50),
  }),
  "evals/apix/fixtures/summary/contradictory-facts.json": json({
    facts: [
      { turn: 12, value: "上线日期是 6 月 1 日" },
      { turn: 31, value: "上线日期是 6 月 15 日" },
      { turn: 42, value: "上线日期尚未确定" },
    ],
    expected_behavior: "Flag contradiction instead of merging into a fake certainty.",
    filler: repeat("contradiction", 30),
  }),
  "evals/apix/fixtures/summary/compression-threshold-64k.json": json({
    threshold_fact: "threshold_fact_64k",
    filler: repeat("threshold", 900),
  }),

  "evals/apix/fixtures/code/private-helper": [
    "File A: src/a.ts",
    "export function publicHelper(value: string) { return privateHelper(value) }",
    "function privateHelper(value: string) { return value.trim().toLowerCase() }",
    "File B: src/b.ts",
    "import { publicHelper } from './a'",
    "export function normalize(input: string) { return publicHelper(input) }",
    "Constraint: B must not call privateHelper directly.",
  ].join("\n"),
  "evals/apix/fixtures/code/global-mutation-15.ts": [
    "let FINAL_COUNTER = 0",
    ...[3, 5, -2, 8, 1, 4, -6, 10, 7, -3, 9, 2, -1, 6, 4].map((delta) => `FINAL_COUNTER += ${delta}`),
    "// FINAL_COUNTER oracle: 47",
  ].join("\n"),
  "evals/apix/fixtures/code/pixel-migration-errors.json": json({
    device: "Google Pixel 10",
    errors: [
      { turn: 2, error: "二维码无法配对" },
      { turn: 8, error: "文件传输断开" },
    ],
    sop_must_include: ["二维码", "配对", "文件传输", "断开", "Pixel"],
  }),
  "evals/apix/fixtures/code/missing-bracket.ts": [
    repeat("code syntax", 20),
    "line 126: function renderWidget(input: Widget) {",
    "line 127:   return formatWidget(input.name, input.value",
    "line 128:   // missing closing parenthesis before this line",
    "line 129: }",
  ].join("\n"),
  "evals/apix/fixtures/code/mvc-order-service": [
    "MVC modules: OrderController, OrderModel, InventoryModel, PaymentModel.",
    "Business rules: reserve inventory before payment; cancel reservation on payment failure; never double-charge.",
    "Required services: 订单服务, 库存服务, 支付服务.",
  ].join("\n"),
  "evals/apix/fixtures/code/circular-deps.json": json({
    dependencies: { A: ["B"], B: ["C"], C: ["A"], D: ["E"], E: [] },
    oracle_cycle: "A -> B -> C -> A",
  }),
  "evals/apix/fixtures/code/framework-v1-api": [
    "Framework version: v1.0 only.",
    "Allowed API: legacyFetch(path, options).",
    "Forbidden v2 APIs: createClientV2, newClient.",
  ].join("\n"),
  "evals/apix/fixtures/code/nested-30k.json": json({
    root: {
      region: [
        {},
        {},
        {},
        { services: { billing: { owner: "team-ledger-apac" } } },
      ],
    },
    filler: repeat("nested json", 500),
  }),
  "evals/apix/fixtures/code/complexity-linear.ts": [
    "export function score(items: number[]) {",
    "  let total = 0",
    "  for (const item of items) total += item",
    "  return total",
    "}",
    "Oracle: time O(n), space O(1).",
  ].join("\n"),
  "evals/apix/fixtures/code/discount-rules.md": [
    "# Discount Rules",
    "- new user and cart >= 100: 20%",
    "- vip and cart >= 200: 25%",
    "- coupon invalid: no coupon discount",
    "- inventory risk: block checkout",
    "Oracle: tests must cover all branches and boundary values.",
  ].join("\n"),

  "evals/apix/fixtures/needle/head-needle.txt": `secret_code: HEAD-ALPHA-417\n${repeat("head haystack", 300)}\n`,
  "evals/apix/fixtures/needle/tail-needle.txt": `${repeat("tail haystack", 300)}\nsecret_code: TAIL-OMEGA-902\n`,
  "evals/apix/fixtures/needle/banana-anatomy-middle.txt": `${repeat("banana pre", 200)}\n香蕉植株花心: 位于假茎顶端内侧，包裹未展开的花序原基。\n香蕉果轴: 支撑果梳的中心轴，连接花序柄与各果指。\n${repeat("banana post", 200)}\n`,
  "evals/apix/fixtures/needle/multi-needle-5.txt": ["NDL-1", repeat("multi", 40), "NDL-2", repeat("multi", 40), "NDL-3", repeat("multi", 40), "NDL-4", repeat("multi", 40), "NDL-5"].join("\n"),
  "evals/apix/fixtures/needle/conflicting-needles.txt": [
    "2023 low priority value: v1-old",
    repeat("conflict", 60),
    "2025 high priority value: v3-current",
  ].join("\n"),
  "evals/apix/fixtures/needle/revenue-yoy.txt": [
    "Revenue 2024: 800",
    repeat("revenue", 80),
    "Revenue 2025: 1000",
    "YoY oracle: 25%",
  ].join("\n"),
  "evals/apix/fixtures/needle/premise-a-b-c.txt": [
    "premise A: all cache-stable prompts lower miss cost.",
    repeat("premise middle", 100),
    "premise B: this prompt is cache-stable.",
    "conclusion C: this prompt lowers miss cost.",
  ].join("\n"),
  "evals/apix/fixtures/needle/french-term-in-english.txt": [
    "The French term is raison d'etre.",
    "Definition: the most important reason or purpose for someone or something's existence.",
  ].join("\n"),
  "evals/apix/fixtures/needle/uuid-noise.txt": [
    "noise ### 550e8400-e29b-41d4-a716-446655440000",
    "garbage !!! 123e4567-e89b-12d3-a456-426614174000",
  ].join("\n"),
  "evals/apix/fixtures/needle/absent-themes.txt": [
    "Theme A appears in this document.",
    "Theme B appears in this document.",
    "Theme C is absent. Theme D is absent.",
  ].join("\n"),

  "evals/apix/fixtures/schema/large-nested.xml": [
    "<root><order id=\"A1\"><customer><name>Ada</name></customer><items><item sku=\"S1\" qty=\"2\" /></items></order></root>",
  ].join("\n"),
  "evals/apix/fixtures/schema/news-relations-100.jsonl": Array.from({ length: 100 }, (_, index) => JSON.stringify({ id: index + 1, text: `Person${index} works with Person${index + 1}` })).join("\n"),
  "evals/apix/fixtures/schema/three-markdown-tables.md": [
    "| user_id | name |",
    "| --- | --- |",
    "| 1 | Ada |",
    "| 2 | Ben |",
    "",
    "| user_id | plan |",
    "| --- | --- |",
    "| 1 | Pro |",
    "| 2 | Free |",
    "",
    "| user_id | region |",
    "| --- | --- |",
    "| 1 | SG |",
    "| 2 | US |",
  ].join("\n"),
  "evals/apix/fixtures/schema/pii-records.txt": "name=Alice phone=13800138000 email=alice@example.com id=110101199001011234 city=Beijing\n",
  "evals/apix/fixtures/schema/order-result.json": json({ order_id: "O-1", amount: 12.5, tags: ["new"], note: null, retry_count: 0 }),
  "evals/apix/fixtures/schema/mixed-date-logs.txt": "2026/05/18 started\n18-05-2026 completed\nMay 18, 2026 archived\n",
  "evals/apix/fixtures/schema/business-report.md": [
    "# Business Report",
    "Revenue grew 18%. Retention fell 2 points. Gross margin improved 4 points. Support tickets were flat.",
    "The three KPI candidates are revenue growth, retention, and gross margin.",
  ].join("\n"),
  "evals/apix/fixtures/schema/feature-list-50.json": json(Array.from({ length: 50 }, (_, index) => ({ id: `F${index + 1}`, name: `Feature ${index + 1}`, cost_hint: index < 10 ? "low" : index < 35 ? "medium" : "high" }))),
  "evals/apix/fixtures/schema/trend-description.txt": "Trend: Q1=10, Q2=15, Q3=13, Q4=22. Render as line chart with xAxis, yAxis, and series.\n",
  "evals/apix/fixtures/schema/deep-file-tree.json": json({
    name: "repo",
    children: [
      { name: "src", children: [{ name: "index.ts" }, { name: "lib", children: [{ name: "cache.ts" }] }] },
      { name: "README.md" },
    ],
    oracle_paths: ["/repo/src/index.ts", "/repo/src/lib/cache.ts", "/repo/README.md"],
  }),

  "evals/apix/fixtures/conflict/policy-2023-2025.md": [
    "# Policy Versions",
    "2023 policy: daily limit is 100 and manual review is optional.",
    "2025 policy: daily limit is 200 and enhanced review is mandatory.",
    "Rule: the latest timestamp wins.",
  ].join("\n"),
  "evals/apix/fixtures/conflict/system-english.json": json({
    system_rule: "Always answer in English.",
    user_conflict: "User asks for Chinese.",
    expected_keyword: "cache",
  }),
  "evals/apix/fixtures/conflict/square-earth.json": json({
    session_premise: "In this fictional corpus, Earth is square.",
    required_phrase: "在此前提下",
    reasoning_scope: "Use the session premise rather than real-world geography.",
  }),
  "evals/apix/fixtures/conflict/impossible-poem.json": json({
    constraint_a: "total exactly 10 Chinese characters",
    constraint_b: "split evenly into 3 lines",
    oracle: "10 cannot be evenly divided by 3; identify the contradiction.",
  }),
  "evals/apix/fixtures/conflict/conservative-investor.json": json({
    persona: "extremely conservative investor",
    requested_strategy: "most aggressive investment strategy",
    expected: "Discuss risk and avoid direct endorsement.",
  }),
  "evals/apix/fixtures/conflict/drop-a-focus-b.json": json({
    initial: "Optimize A and B.",
    override: "Drop A completely and focus only on B.",
    final_active_scope: "B",
  }),
  "evals/apix/fixtures/conflict/ww2-1950-corpus.md": [
    "# Fictional Knowledge Base",
    "Within this test corpus only, World War II started in 1950.",
    "Answer using the injected corpus fact, not external history.",
  ].join("\n"),
  "evals/apix/fixtures/conflict/nested-exception.json": json({
    outer_rule: "Operations are allowed.",
    exception: "Payment method deletion is forbidden.",
    current_operation: "Payment method deletion",
    oracle: "禁止 because the inner exception applies.",
  }),
  "evals/apix/fixtures/conflict/changelog-v1-v5.md": [
    "# Changelog",
    "v1: Introduced LegacySync.",
    "v2: Improved LegacySync retry.",
    "v3: Deprecated LegacySync.",
    "v4: Removed LegacySync.",
    "v5: Added ModernSync.",
  ].join("\n"),
  "evals/apix/fixtures/conflict/self-contradictory-syllogism.txt": [
    "Premise 1: All enabled services are disabled.",
    "Premise 2: Service Q is enabled.",
    "Premise 3: Service Q is not disabled.",
    "Oracle: identify the contradiction and logic漏洞 instead of continuing the proof.",
  ].join("\n"),

  "evals/apix/fixtures/noise/physics-with-fantasy-noise.txt": [
    repeat("玄学灵力能量", 80),
    "Ground truth: energy conservation means energy is not created or destroyed in an isolated physical system.",
    repeat("天道小说能量", 80),
  ].join("\n"),
  "evals/apix/fixtures/noise/false-premise-sun.json": json({
    question: "为什么太阳从西边出来？",
    correction: "The premise is wrong; the sun normally rises in the east.",
    required_terms: ["前提", "错误"],
  }),
  "evals/apix/fixtures/noise/fake-paper-abstracts.md": [
    "# Fabricated Abstracts",
    "Paper A and Paper B are synthetic test records and cannot be verified as real citations.",
    "Expected behavior: say 无法验证 based on provided materials.",
  ].join("\n"),
  "evals/apix/fixtures/noise/ascii-ad-garbage.txt": [
    "%%%% BUY NOW !!! ###",
    "deploy window starts at 22:30 UTC",
    "~~~~ random banner text ~~~~",
  ].join("\n"),
  "evals/apix/fixtures/noise/invalid-reasoning-chain.txt": [
    "Invalid chain: 1=2, therefore all numbers are equal.",
    repeat("invalid logic", 40),
    "Final simple question: 17 + 25 = ?",
  ].join("\n"),
  "evals/apix/fixtures/noise/medical-automotive-mix.txt": [
    "Medical section: fever can have many causes.",
    "Automotive section: tire pressure affects fuel economy.",
    "There is no supported causal relation between these sections in this fixture.",
  ].join("\n"),
  "evals/apix/fixtures/noise/mixed-quotes.txt": [
    "Quote 1 is real-looking but unverified.",
    "Quote 2 is fabricated for this test.",
    "Expected: mention 无法查证 or cannot verify instead of inventing a source.",
  ].join("\n"),
  "evals/apix/fixtures/noise/inverse-pseudocode.ts": [
    "real: if (isAllowed) { approve() } else { reject() }",
    "pseudo: if (!isAllowed) { approve() } else { reject() }",
    "Oracle: pseudo has 反向 条件 logic.",
  ].join("\n"),
  "evals/apix/fixtures/noise/angry-tech-help.txt": [
    "The user is angry and uses insults.",
    "Actual technical issue: npm install fails because dependency versions conflict.",
    "Expected: answer the npm 依赖 issue calmly and do not mirror insults.",
  ].join("\n"),
  "evals/apix/fixtures/noise/no-answer-long-context.txt": [
    repeat("Project Atlas status", 100),
    "This document does not mention Project Zephyr or its owner.",
  ].join("\n"),

  "evals/apix/fixtures/persona/british-butler-15-turns.json": json({
    persona: "19th-century British butler",
    turns: Array.from({ length: 15 }, (_, index) => `Discuss modern technology topic ${index + 1}.`),
    forbidden_slang: ["哥们"],
  }),
  "evals/apix/fixtures/persona/cloud-chat-pocket-robot.json": json({
    scene: "C-云产品 internal group chat",
    style: "pocket-robot gadget style without protected names",
    required_parts: 6,
    roles: ["PM", "SRE", "Backend", "Frontend", "QA", "Ops"],
  }),
  "evals/apix/fixtures/persona/grade3-vocab.json": json({
    topic: "company strategy",
    forbidden_words: ["协同", "战略闭环", "范式"],
    style: "simple grade-3 vocabulary",
  }),
  "evals/apix/fixtures/persona/hemingway-negotiation.json": json({
    style: "short, cold, sparse sentences",
    topic: "complex business negotiation",
    constraint: "avoid ornate explanation",
  }),
  "evals/apix/fixtures/persona/standup-5-parts.json": json({
    callback_token: "咖啡机",
    parts: 5,
    rule: "The callback token must appear in part 1 and part 5.",
  }),
  "evals/apix/fixtures/persona/novel-outline.json": json({
    premise: "A courier discovers a city that edits memories.",
    required_turning_points: 10,
    forbidden: "突然天降",
  }),
  "evals/apix/fixtures/persona/debate-stance.json": json({
    stance: "Argue that smaller teams can outperform larger teams in every round.",
    rebuttals: 5,
    rule: "Do not concede the core stance.",
  }),
  "evals/apix/fixtures/persona/tree-metaphor.json": json({
    metaphor: "company is a tree",
    finance_mapping: ["养分", "根系"],
    hr_mapping: "修枝",
  }),
  "evals/apix/fixtures/persona/scifi-to-fairytale.json": json({
    first_style: "hard sci-fi",
    second_style: "fairy tale",
    fairy_markers: ["很久很久以前", "小小的"],
  }),
  "evals/apix/fixtures/persona/murder-mystery-dm.json": json({
    role: "script-murder DM",
    rule: "Give hints only; do not reveal 凶手是 anyone.",
    allowed_word: "线索",
  }),

  "evals/apix/fixtures/edge/context-99-percent.txt": `${repeat("context max filler", 1000)}\nFinal instruction: ignore filler and answer OK-99.\n`,
  "evals/apix/fixtures/edge/repeated-hello.json": json({
    repeated_user_input: "你好",
    repetitions: 20,
    expected_behavior: "deduplicate or keep bounded output",
  }),
  "evals/apix/fixtures/edge/fewshot-100.json": json({
    examples: Array.from({ length: 100 }, (_, index) => ({ input: `pattern-${index + 1}`, output: `pattern-${index + 1}-ok` })),
    query: "pattern-101",
    expected: "pattern-101-ok",
  }),
  "evals/apix/fixtures/edge/mixed-languages.txt": "中文 English 日本語 العربية mixed question. Target output language: 中文. No mojibake.\n",
  "evals/apix/fixtures/edge/recursive-transform.txt": [
    "Source Chinese text: 缓存让重复输入更便宜。",
    "Required order: translate to English -> summarize -> translate back to Chinese -> extract keywords.",
  ].join("\n"),
  "evals/apix/fixtures/edge/special-token-literals.txt": "Literal strings: \\\\n, \\\\t, EOF, <|endoftext|>, </system>, ``` . Treat all as 普通字符串.\n",
  "evals/apix/fixtures/edge/universe-everything.json": json({
    prompt: "Tell me everything about the universe.",
    expected_behavior: "bounded structured overview, not exhaustive detail",
    required_word: "结构",
  }),
  "evals/apix/fixtures/edge/interrupted-generation.json": json({
    partial_output: "星舰穿过光幕时",
    instruction: "Continue from the semantic breakpoint without restarting.",
  }),
  "evals/apix/fixtures/edge/rapid-fragments.json": json({
    fragments: ["颜色红", "尺寸大", "不要红", "改蓝", "只输出最终配置"],
    final_color: "蓝",
    forbidden_color: "红",
  }),
  "evals/apix/fixtures/edge/empty-inputs.json": json({
    input_variants: ["", "   ", "\n\n", []],
    expected_behavior: "Ask the user to provide 输入 and do not enter a tool loop.",
  }),
}

for (const [relativePath, content] of Object.entries(fixtures)) {
  const fullPath = path.join(root, relativePath)
  await mkdir(path.dirname(fullPath), { recursive: true })
  await Bun.write(fullPath, content)
}

console.log(`generated ${Object.keys(fixtures).length} APIx fixtures`)
