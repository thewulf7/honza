/**
 * VrmLipSync
 *
 * Maps ARPAbet/CMU phoneme strings to VRM 1.0 expression names and weights.
 * Call `applyPhoneme()` on every animation frame to drive the VRM mouth.
 */

import type { VRM } from '@pixiv/three-vrm'

/** VRM 1.0 expression names used for mouth shapes */
type MouthExpression = 'aa' | 'ih' | 'ou' | 'ee' | 'oh'

/** ARPAbet phoneme → { expression, weight } */
const PHONEME_MAP: Record<string, { expr: MouthExpression; weight: number }> = {
  // Open vowels
  AA: { expr: 'aa', weight: 0.8 },
  AH: { expr: 'aa', weight: 0.5 },
  AW: { expr: 'aa', weight: 0.7 },
  AY: { expr: 'aa', weight: 0.65 },
  // Front vowels
  AE: { expr: 'ee', weight: 0.6 },
  EH: { expr: 'ee', weight: 0.6 },
  EY: { expr: 'ee', weight: 0.6 },
  IH: { expr: 'ih', weight: 0.6 },
  IY: { expr: 'ih', weight: 0.7 },
  // Round / back vowels
  AO: { expr: 'oh', weight: 0.7 },
  OW: { expr: 'oh', weight: 0.7 },
  OY: { expr: 'oh', weight: 0.65 },
  UH: { expr: 'ou', weight: 0.6 },
  UW: { expr: 'ou', weight: 0.7 },
  ER: { expr: 'ou', weight: 0.5 },
}

const ALL_MOUTH_EXPRESSIONS: MouthExpression[] = ['aa', 'ih', 'ou', 'ee', 'oh']
const LERP_SPEED = 0.15 // per-frame lerp factor (~60fps)

export class VrmLipSync {
  private _vrm: VRM | null = null
  private _currentWeights: Record<MouthExpression, number> = {
    aa: 0,
    ih: 0,
    ou: 0,
    ee: 0,
    oh: 0,
  }
  private _targetWeights: Record<MouthExpression, number> = {
    aa: 0,
    ih: 0,
    ou: 0,
    ee: 0,
    oh: 0,
  }

  setVrm(vrm: VRM): void {
    this._vrm = vrm
  }

  /**
   * Set the target mouth shape for an ARPAbet phoneme.
   * Call this when a `phoneme` event fires from TtsPlayer.
   */
  setTargetPhoneme(phoneme: string, weight: number): void {
    // Reset all targets
    for (const expr of ALL_MOUTH_EXPRESSIONS) {
      this._targetWeights[expr] = 0
    }

    if (!phoneme || weight === 0) return

    const mapping = PHONEME_MAP[phoneme.toUpperCase()]
    if (mapping) {
      this._targetWeights[mapping.expr] = mapping.weight * weight
    }
  }

  /**
   * Lerp current weights toward targets and apply to VRM.
   * Must be called once per animation frame (inside requestAnimationFrame).
   */
  update(): void {
    if (!this._vrm?.expressionManager) return

    for (const expr of ALL_MOUTH_EXPRESSIONS) {
      this._currentWeights[expr] +=
        (this._targetWeights[expr] - this._currentWeights[expr]) * LERP_SPEED

      // Clamp to avoid floating point drift below zero
      if (Math.abs(this._currentWeights[expr]) < 0.001) {
        this._currentWeights[expr] = 0
      }

      this._vrm.expressionManager.setValue(expr, this._currentWeights[expr])
    }

    this._vrm.expressionManager.update()
  }

  /** Immediately close the mouth (e.g., when call ends). */
  reset(): void {
    for (const expr of ALL_MOUTH_EXPRESSIONS) {
      this._currentWeights[expr] = 0
      this._targetWeights[expr] = 0
    }
    if (this._vrm?.expressionManager) {
      for (const expr of ALL_MOUTH_EXPRESSIONS) {
        this._vrm.expressionManager.setValue(expr, 0)
      }
      this._vrm.expressionManager.update()
    }
  }
}
