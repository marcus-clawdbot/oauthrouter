/**
 * Default Routing Config
 *
 * All routing parameters as a TypeScript constant.
 * Operators override via openclaw.yaml plugin config.
 *
 * Scoring uses 14 weighted dimensions with sigmoid confidence calibration.
 */

import type { RoutingConfig } from "./types.js";
import { FALLBACK_MODELS } from "../fallback-config.js";

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  version: "2.0",

  classifier: {
    llmModel: "google/gemini-2.5-flash",
    llmMaxTokens: 10,
    llmTemperature: 0,
    promptTruncationChars: 500,
    cacheTtlMs: 3_600_000, // 1 hour
  },

  scoring: {
    tokenCountThresholds: { simple: 50, complex: 500 },

    // Multilingual keywords: English + Chinese (中文) + Japanese (日本語) + Russian (Русский)
    codeKeywords: [
      // English
      "function",
      "class",
      "import",
      "def",
      "SELECT",
      "async",
      "await",
      "const",
      "let",
      "var",
      "return",
      "```",
      // Chinese
      "函数",
      "类",
      "导入",
      "定义",
      "查询",
      "异步",
      "等待",
      "常量",
      "变量",
      "返回",
      // Japanese
      "関数",
      "クラス",
      "インポート",
      "非同期",
      "定数",
      "変数",
      // Russian
      "функция",
      "класс",
      "импорт",
      "запрос",
      "асинхронный",
      "константа",
      "переменная",
    ],
    reasoningKeywords: [
      // English
      "prove",
      "theorem",
      "derive",
      "step by step",
      "chain of thought",
      "formally",
      "mathematical",
      "proof",
      "logically",
      // Chinese
      "证明",
      "定理",
      "推导",
      "逐步",
      "思维链",
      "形式化",
      "数学",
      "逻辑",
      // Japanese
      "証明",
      "定理",
      "導出",
      "ステップバイステップ",
      "論理的",
      // Russian
      "доказать",
      "теорема",
      "вывести",
      "шаг за шагом",
      "цепочка рассуждений",
      "формально",
      "математически",
      "логически",
    ],
    simpleKeywords: [
      // English
      "what is",
      "define",
      "translate",
      "hello",
      "yes or no",
      "capital of",
      "how old",
      "who is",
      "when was",
      // Chinese
      "什么是",
      "定义",
      "翻译",
      "你好",
      "是否",
      "首都",
      "多大",
      "谁是",
      "何时",
      // Japanese
      "とは",
      "定義",
      "翻訳",
      "こんにちは",
      "はいかいいえ",
      "首都",
      "誰",
      // Russian
      "что такое",
      "определение",
      "перевести",
      "привет",
      "да или нет",
      "столица",
      "кто такой",
      "когда",
    ],
    technicalKeywords: [
      // English
      "algorithm",
      "optimize",
      "architecture",
      "distributed",
      "kubernetes",
      "microservice",
      "database",
      "infrastructure",
      // Chinese
      "算法",
      "优化",
      "架构",
      "分布式",
      "微服务",
      "数据库",
      "基础设施",
      // Japanese
      "アルゴリズム",
      "最適化",
      "アーキテクチャ",
      "分散",
      "マイクロサービス",
      "データベース",
      // Russian
      "алгоритм",
      "оптимизировать",
      "архитектура",
      "распределённый",
      "микросервис",
      "база данных",
      "инфраструктура",
    ],
    creativeKeywords: [
      // English
      "story",
      "poem",
      "compose",
      "brainstorm",
      "creative",
      "imagine",
      "write a",
      // Chinese
      "故事",
      "诗",
      "创作",
      "头脑风暴",
      "创意",
      "想象",
      "写一个",
      // Japanese
      "物語",
      "詩",
      "作曲",
      "ブレインストーム",
      "創造的",
      "想像",
      // Russian
      "история",
      "стихотворение",
      "сочинить",
      "мозговой штурм",
      "творческий",
      "представить",
      "напиши",
    ],

    // New dimension keyword lists (multilingual)
    imperativeVerbs: [
      // English
      "build",
      "create",
      "implement",
      "design",
      "develop",
      "construct",
      "generate",
      "deploy",
      "configure",
      "set up",
      // Chinese
      "构建",
      "创建",
      "实现",
      "设计",
      "开发",
      "生成",
      "部署",
      "配置",
      "设置",
      // Japanese
      "構築",
      "作成",
      "実装",
      "設計",
      "開発",
      "生成",
      "デプロイ",
      "設定",
      // Russian
      "построить",
      "создать",
      "реализовать",
      "спроектировать",
      "разработать",
      "сгенерировать",
      "развернуть",
      "настроить",
    ],
    constraintIndicators: [
      // English
      "under",
      "at most",
      "at least",
      "within",
      "no more than",
      "o(",
      "maximum",
      "minimum",
      "limit",
      "budget",
      // Chinese
      "不超过",
      "至少",
      "最多",
      "在内",
      "最大",
      "最小",
      "限制",
      "预算",
      // Japanese
      "以下",
      "最大",
      "最小",
      "制限",
      "予算",
      // Russian
      "не более",
      "как минимум",
      "максимум",
      "минимум",
      "ограничение",
      "бюджет",
    ],
    outputFormatKeywords: [
      // English
      "json",
      "yaml",
      "xml",
      "table",
      "csv",
      "markdown",
      "schema",
      "format as",
      "structured",
      // Chinese
      "表格",
      "格式化为",
      "结构化",
      // Japanese
      "テーブル",
      "フォーマット",
      "構造化",
      // Russian
      "таблица",
      "форматировать как",
      "структурированный",
    ],
    referenceKeywords: [
      // English
      "above",
      "below",
      "previous",
      "following",
      "the docs",
      "the api",
      "the code",
      "earlier",
      "attached",
      // Chinese
      "上面",
      "下面",
      "之前",
      "接下来",
      "文档",
      "代码",
      "附件",
      // Japanese
      "上記",
      "下記",
      "前の",
      "次の",
      "ドキュメント",
      "コード",
      // Russian
      "выше",
      "ниже",
      "предыдущий",
      "следующий",
      "документация",
      "код",
      "вложение",
    ],
    negationKeywords: [
      // English
      "don't",
      "do not",
      "avoid",
      "never",
      "without",
      "except",
      "exclude",
      "no longer",
      // Chinese
      "不要",
      "避免",
      "从不",
      "没有",
      "除了",
      "排除",
      // Japanese
      "しないで",
      "避ける",
      "決して",
      "なしで",
      "除く",
      // Russian
      "не делай",
      "избегать",
      "никогда",
      "без",
      "кроме",
      "исключить",
    ],
    domainSpecificKeywords: [
      // English
      "quantum",
      "fpga",
      "vlsi",
      "risc-v",
      "asic",
      "photonics",
      "genomics",
      "proteomics",
      "topological",
      "homomorphic",
      "zero-knowledge",
      "lattice-based",
      // Chinese
      "量子",
      "光子学",
      "基因组学",
      "蛋白质组学",
      "拓扑",
      "同态",
      "零知识",
      "格密码",
      // Japanese
      "量子",
      "フォトニクス",
      "ゲノミクス",
      "トポロジカル",
      // Russian
      "квантовый",
      "фотоника",
      "геномика",
      "протеомика",
      "топологический",
      "гомоморфный",
      "с нулевым разглашением",
    ],

    // Dimension weights (sum to 1.0)
    dimensionWeights: {
      tokenCount: 0.08,
      codePresence: 0.15,
      reasoningMarkers: 0.18,
      technicalTerms: 0.1,
      creativeMarkers: 0.05,
      simpleIndicators: 0.12,
      multiStepPatterns: 0.12,
      questionComplexity: 0.05,
      imperativeVerbs: 0.03,
      constraintCount: 0.04,
      outputFormat: 0.03,
      referenceComplexity: 0.02,
      negationComplexity: 0.01,
      domainSpecificity: 0.02,
    },

    // Tier boundaries on weighted score axis
    tierBoundaries: {
      simpleMedium: 0.0,
      mediumComplex: 0.15,
      complexReasoning: 0.25,
    },

    // Sigmoid steepness for confidence calibration
    confidenceSteepness: 12,
    // Below this confidence → ambiguous (null tier)
    confidenceThreshold: 0.7,
  },

  tiers: {
    SIMPLE: {
      primary: "anthropic/claude-haiku-4-5",
      // Prefer the smaller Codex model for SIMPLE to control cost and verbosity.
      fallback: [FALLBACK_MODELS["openai-codex"].SIMPLE],
    },
    MEDIUM: {
      primary: "openai-codex/gpt-5.2-codex",
      fallback: ["anthropic/claude-sonnet-4-6", FALLBACK_MODELS["openai-codex"].MEDIUM],
    },
    COMPLEX: {
      primary: "anthropic/claude-sonnet-4-6",
      fallback: ["anthropic/claude-opus-4-5", FALLBACK_MODELS["openai-codex"].COMPLEX],
    },
    REASONING: {
      primary: "anthropic/claude-opus-4-6",
      fallback: ["anthropic/claude-opus-4-5", FALLBACK_MODELS["openai-codex"].REASONING],
    },
  },

  overrides: {
    maxTokensForceComplex: 100_000,
    structuredOutputMinTier: "MEDIUM",
    imageMinTier: "COMPLEX",
    ambiguousDefaultTier: "MEDIUM",
  },
};
