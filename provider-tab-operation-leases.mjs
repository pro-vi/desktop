import { AsyncLocalStorage } from 'node:async_hooks';

const OPERATION_FIELDS = Object.freeze([
  'id',
  'kind',
  'tabId',
  'key',
  'source',
  'phase',
  'scope',
  'startedAt'
]);

function requiredText(value, code) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return text;
}

function safeOperation(value) {
  const id = requiredText(value?.id, 'provider_tab_operation_id_required');
  const operation = { id };
  for (const field of OPERATION_FIELDS) {
    if (field === 'id' || value?.[field] === undefined) continue;
    const fieldValue = value[field];
    if (
      fieldValue === null ||
      typeof fieldValue === 'string' ||
      typeof fieldValue === 'number' ||
      typeof fieldValue === 'boolean'
    ) {
      operation[field] = fieldValue;
    }
  }
  return operation;
}

export function providerTabOperationEvidence(value) {
  return safeOperation(value);
}

function busyError(scope, operation) {
  const error = new Error('tab_busy');
  error.code = 'tab_busy';
  error.data = {
    scope,
    activeQuery: { ...operation }
  };
  return error;
}

export function createProviderTabOperationLeases() {
  const active = new Map();
  const ownerContext = new AsyncLocalStorage();

  const current = (scopeValue) => {
    const scope = requiredText(scopeValue, 'provider_tab_operation_scope_required');
    const operation = active.get(scope);
    return operation ? { ...operation } : null;
  };

  const assertAvailable = (scopeValue, ownerIdValue = null) => {
    const scope = requiredText(scopeValue, 'provider_tab_operation_scope_required');
    const ownerId = typeof ownerIdValue === 'string' ? ownerIdValue.trim() : '';
    const operation = active.get(scope);
    if (!operation || (
      ownerId &&
      operation.id === ownerId &&
      ownerContext.getStore() === ownerId
    )) return;
    throw busyError(scope, operation);
  };

  // Returns true only when this call creates the lease. Re-entering with the
  // same operation ID is intentional: post-query capture can reuse the query's
  // key and tab ownership without releasing the outer operation's leases.
  const reserve = (scopeValue, operationValue) => {
    const scope = requiredText(scopeValue, 'provider_tab_operation_scope_required');
    const operation = safeOperation(operationValue);
    const existing = active.get(scope);
    if (existing?.id === operation.id && ownerContext.getStore() === operation.id) return false;
    if (existing) throw busyError(scope, existing);
    active.set(scope, { ...operation, scope });
    return true;
  };

  const release = (scopeValue, expectedIdValue = null) => {
    const scope = requiredText(scopeValue, 'provider_tab_operation_scope_required');
    const expectedId = typeof expectedIdValue === 'string' ? expectedIdValue.trim() : '';
    const operation = active.get(scope);
    if (!operation || (expectedId && operation.id !== expectedId)) return false;
    active.delete(scope);
    return true;
  };

  const releaseAll = (operationIdValue) => {
    const operationId = requiredText(operationIdValue, 'provider_tab_operation_id_required');
    const released = [];
    for (const [scope, operation] of active.entries()) {
      if (operation.id !== operationId) continue;
      active.delete(scope);
      released.push(scope);
    }
    return released;
  };

  const snapshot = () => Array.from(active.entries())
    .map(([scope, operation]) => ({ scope, operation: { ...operation } }))
    .sort((a, b) => a.scope.localeCompare(b.scope));

  const currentOwnerId = () => ownerContext.getStore() || null;

  const runWithOwner = async (operationIdValue, operation) => {
    const operationId = requiredText(operationIdValue, 'provider_tab_operation_id_required');
    if (typeof operation !== 'function') {
      const error = new Error('provider_tab_operation_callback_required');
      error.code = 'provider_tab_operation_callback_required';
      throw error;
    }
    return await ownerContext.run(operationId, operation);
  };

  return Object.freeze({
    assertAvailable,
    current,
    currentOwnerId,
    release,
    releaseAll,
    reserve,
    runWithOwner,
    snapshot
  });
}
