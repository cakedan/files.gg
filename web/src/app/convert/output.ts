import { useState } from 'react';

import type { ConversionOutputParams } from '../../lib/conversions';
import { defaultPickerState, resolvePickers, type PickerContext, type PickerErrors, type PickerState } from '../../lib/upload/options';

/**
 * The new file's "Who can open it", "Expires" and view limit on the Convert page (milestone-5 §5.3, §5.5,
 * §10.3, §21), with the Upload page's pickers.
 */

/**
 * Where the pickers start: what the API does when the request sends no output fields. A protected source's
 * output is protected too (signed in: only you; guests: a generated password); otherwise the account's upload
 * defaults, or for guests a link for 21 days.
 */
export function outputPickerState(context: PickerContext, protectedSource: boolean, nowMs: number = Date.now()): PickerState {
  const state = defaultPickerState(context, nowMs);
  if (!protectedSource) return state;
  return context.anonymous ? { ...state, visibility: 'password', generatePassword: true } : { ...state, visibility: 'private', generatePassword: false };
}

export interface ResolvedOutput {
  params: ConversionOutputParams;
  errors: PickerErrors;
}

/**
 * The output fields to send. Untouched, none: the API's rules decide, as the pickers show. Changed, all of
 * them as shown (`expires_in: null` is never), only those §10.3 takes, and no view limit for guests.
 */
export function resolveOutput(state: PickerState, context: PickerContext, touched: boolean, nowMs: number = Date.now()): ResolvedOutput {
  const resolved = resolvePickers(state, context, nowMs);
  const { unlockTtl: _unlockTtl, passwordExpiry: _passwordExpiry, ...errors } = resolved.errors;
  if (!touched) return { params: {}, errors };
  const params: ConversionOutputParams = { visibility: state.visibility, expires_in: resolved.params.expires_in ?? null };
  if (resolved.params.password !== undefined) params.password = resolved.params.password;
  if (resolved.params.generate_password) params.generate_password = true;
  if (!context.anonymous && resolved.params.view_limit !== undefined) {
    params.view_limit = resolved.params.view_limit;
    params.view_limit_action = resolved.params.view_limit_action ?? 'expire';
  }
  return { params, errors };
}

/** The pickers' state: they follow the context and the source until the user changes one. */
export function useOutputPickers(context: PickerContext, protectedSource: boolean) {
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState(() => outputPickerState(context, protectedSource));
  const [startedFrom, setStartedFrom] = useState({ context, protectedSource });
  if (!touched && (startedFrom.context !== context || startedFrom.protectedSource !== protectedSource)) {
    setStartedFrom({ context, protectedSource });
    setState(outputPickerState(context, protectedSource));
  }
  return {
    state,
    ...resolveOutput(state, context, touched),
    onChange: (patch: Partial<PickerState>) => {
      setTouched(true);
      setState((current) => ({ ...current, ...patch }));
    },
  };
}
