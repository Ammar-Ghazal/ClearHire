# ClearHire Skill Metrics v1

Catalogue ID: `clearhire-skills-v1`. **100 skills across 10 categories.**

**Superseded as the canonical source by v2:** `packages/shared/src/skill-catalogue.ts` (`clearhire-skills` version 2) keeps these exact IDs and adds a definition and skill-specific level 1–3 criteria for each skill. This JSON file is frozen as the reference for ID stability; a test fails if v2 changes or reorders an ID. Candidate analysis and job parsing should reference the same `catalogue_id` and `skill_id`. IDs are stable within v1; label edits must not silently change IDs, and IDs must not be reused for different capabilities. This defines vocabulary, not a scoring rubric.

Languages and tools such as Python, React, AWS and PostgreSQL are supporting tags. A tool tag alone does not demonstrate an engineering capability.

Source: the skill list supplied by Ammar. ESCO was suggested as a possible origin, but exact ESCO mappings have not been verified. These IDs are ClearHire IDs, not ESCO identifiers.

## 1. Programming fundamentals

| Skill ID | Skill |
| --- | --- |
| `data-structures` | Data structures |
| `algorithms` | Algorithms |
| `complexity-analysis` | Complexity analysis |
| `code-organization-and-modularity` | Code organization and modularity |
| `object-oriented-design` | Object-oriented design |
| `functional-programming` | Functional programming |
| `error-handling` | Error handling |
| `concurrency-and-asynchronous-programming` | Concurrency and asynchronous programming |
| `memory-management` | Memory management |
| `debugging` | Debugging |

## 2. Software design and quality

| Skill ID | Skill |
| --- | --- |
| `api-design` | API design |
| `domain-modeling` | Domain modeling |
| `design-patterns` | Design patterns |
| `refactoring` | Refactoring |
| `unit-testing` | Unit testing |
| `integration-testing` | Integration testing |
| `end-to-end-testing` | End-to-end testing |
| `property-based-testing` | Property-based testing |
| `static-analysis-and-type-safety` | Static analysis and type safety |
| `technical-documentation` | Technical documentation |

## 3. Frontend engineering

| Skill ID | Skill |
| --- | --- |
| `semantic-html` | Semantic HTML |
| `css-and-layout` | CSS and layout |
| `responsive-design` | Responsive design |
| `accessibility` | Accessibility |
| `component-architecture` | Component architecture |
| `client-state-management` | Client state management |
| `forms-and-input-validation` | Forms and input validation |
| `browser-networking-and-data-fetching` | Browser networking and data fetching |
| `frontend-performance` | Frontend performance |
| `server-rendering-and-hydration` | Server rendering and hydration |

## 4. Backend engineering

| Skill ID | Skill |
| --- | --- |
| `http-service-implementation` | HTTP service implementation |
| `authentication` | Authentication |
| `authorization` | Authorization |
| `business-workflow-implementation` | Business workflow implementation |
| `background-job-processing` | Background job processing |
| `event-driven-application-development` | Event-driven application development |
| `external-service-integration` | External service integration |
| `caching-implementation` | Caching implementation |
| `real-time-communication` | Real-time communication |
| `api-versioning-and-compatibility` | API versioning and compatibility |

## 5. Databases and data engineering

| Skill ID | Skill |
| --- | --- |
| `relational-schema-design` | Relational schema design |
| `sql-querying` | SQL querying |
| `query-optimization-and-indexing` | Query optimization and indexing |
| `transactions-and-consistency` | Transactions and consistency |
| `database-migrations` | Database migrations |
| `non-relational-data-modeling` | Non-relational data modeling |
| `batch-data-pipelines` | Batch data pipelines |
| `streaming-data-pipelines` | Streaming data pipelines |
| `data-quality-and-validation` | Data quality and validation |
| `data-warehouse-modeling` | Data warehouse modeling |

## 6. Systems and architecture

| Skill ID | Skill |
| --- | --- |
| `distributed-system-design` | Distributed system design |
| `service-decomposition` | Service decomposition |
| `inter-service-communication` | Inter-service communication |
| `fault-tolerance` | Fault tolerance |
| `scalability-and-capacity-planning` | Scalability and capacity planning |
| `system-performance-profiling` | System performance profiling |
| `storage-system-design` | Storage system design |
| `network-programming` | Network programming |
| `operating-system-integration` | Operating system integration |
| `embedded-and-resource-constrained-software` | Embedded and resource-constrained software |

## 7. Cloud, DevOps and reliability

| Skill ID | Skill |
| --- | --- |
| `containerization` | Containerization |
| `container-orchestration` | Container orchestration |
| `infrastructure-as-code` | Infrastructure as code |
| `ci-cd-pipelines` | CI/CD pipelines |
| `cloud-infrastructure-configuration` | Cloud infrastructure configuration |
| `deployment-and-release-engineering` | Deployment and release engineering |
| `observability-and-instrumentation` | Observability and instrumentation |
| `incident-diagnosis-and-recovery` | Incident diagnosis and recovery |
| `backup-and-disaster-recovery` | Backup and disaster recovery |
| `infrastructure-cost-optimization` | Infrastructure cost optimization |

## 8. Machine learning and AI

| Skill ID | Skill |
| --- | --- |
| `data-preparation-and-feature-engineering` | Data preparation and feature engineering |
| `statistical-analysis-and-experimentation` | Statistical analysis and experimentation |
| `classical-machine-learning` | Classical machine learning |
| `deep-learning` | Deep learning |
| `model-evaluation-and-validation` | Model evaluation and validation |
| `natural-language-processing` | Natural language processing |
| `computer-vision` | Computer vision |
| `retrieval-and-search-systems` | Retrieval and search systems |
| `llm-application-and-agent-engineering` | LLM application and agent engineering |
| `model-deployment-and-monitoring` | Model deployment and monitoring |

## 9. Security engineering

| Skill ID | Skill |
| --- | --- |
| `threat-modeling` | Threat modeling |
| `secure-input-handling` | Secure input handling |
| `secrets-and-key-management` | Secrets and key management |
| `cryptographic-implementation-and-integration` | Cryptographic implementation and integration |
| `network-security` | Network security |
| `application-security-testing` | Application security testing |
| `dependency-and-supply-chain-security` | Dependency and supply-chain security |
| `security-logging-and-detection` | Security logging and detection |
| `privacy-engineering` | Privacy engineering |
| `infrastructure-security-hardening` | Infrastructure security hardening |

## 10. Mobile and specialized applications

| Skill ID | Skill |
| --- | --- |
| `native-mobile-development` | Native mobile development |
| `cross-platform-mobile-development` | Cross-platform mobile development |
| `mobile-lifecycle-and-state-management` | Mobile lifecycle and state management |
| `offline-first-synchronization` | Offline-first synchronization |
| `device-hardware-integration` | Device hardware integration |
| `desktop-application-development` | Desktop application development |
| `command-line-tool-development` | Command-line tool development |
| `developer-tooling-and-build-systems` | Developer tooling and build systems |
| `graphics-and-interactive-visualization` | Graphics and interactive visualization |
| `game-and-simulation-development` | Game and simulation development |
