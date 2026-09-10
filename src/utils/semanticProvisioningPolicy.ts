// src/utils/semanticProvisioningPolicy.ts
// Headless Semantic Context Provisioning decision policy.
// Deliberately dependency-free: no React Native, NetInfo, expo, llama.rn,
// or modelManager. LOCAL_LLM_ENABLED is not an input — Qwen/classifier
// download gating does not establish semantic-model readiness.
//
// Certified preview artifact remains Llama-3.2-3B-Instruct Q4_K_M; this
// module only decides whether the shared semantic context may provision it.

export type SemanticConsumerFlags = {
  medicationSemanticEnabled: boolean;
  capabilityDispatchEnabled: boolean;
  grocerySemanticEnabled: boolean;
};

export type SemanticProvisioningFacts = SemanticConsumerFlags & {
  modelPresent: boolean;
  wifiPermitted: boolean;
};

export type SemanticProvisioningAction = 'none' | 'ready' | 'provision' | 'wait';

export function semanticConsumersRequireContext(flags: SemanticConsumerFlags): boolean {
  return flags.medicationSemanticEnabled
    || flags.capabilityDispatchEnabled
    || flags.grocerySemanticEnabled;
}

export function resolveSemanticProvisioningAction(
  facts: SemanticProvisioningFacts,
): SemanticProvisioningAction {
  if (!semanticConsumersRequireContext(facts)) return 'none';
  if (facts.modelPresent) return 'ready';
  if (facts.wifiPermitted) return 'provision';
  return 'wait';
}
