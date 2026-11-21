import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  HAND_TOOL_GRIP_OFFSET,
  HAND_TOOL_GRIP_QUATERNION,
  resolveAttackClipKind,
} from './controller';

describe('player controller tool-aware combat & hand_R grip math', () => {
  it('routes axe and pickaxe attacks strictly to dedicated tool swings and alternates punches only for bare fists', () => {
    expect(resolveAttackClipKind('axe', false)).toBe('axe');
    expect(resolveAttackClipKind('axe', true)).toBe('axe');
    expect(resolveAttackClipKind('pickaxe', false)).toBe('pickaxe');
    expect(resolveAttackClipKind('pickaxe', true)).toBe('pickaxe');
    expect(resolveAttackClipKind('fists', false)).toBe('fists_right');
    expect(resolveAttackClipKind('fists', true)).toBe('fists_left');
  });

  it('mounts hand tools upright with forward-facing cutting blade on the measured idle hand_R basis', () => {
    const gripQuat = new THREE.Quaternion(
      HAND_TOOL_GRIP_QUATERNION.x,
      HAND_TOOL_GRIP_QUATERNION.y,
      HAND_TOOL_GRIP_QUATERNION.z,
      HAND_TOOL_GRIP_QUATERNION.w,
    );
    expect(Math.abs(gripQuat.length() - 1)).toBeLessThan(1e-4);

    // Palm offset sits cleanly along the bone shaft inside the curled hand_R grip
    expect(HAND_TOOL_GRIP_OFFSET.x).toBe(0);
    expect(HAND_TOOL_GRIP_OFFSET.y).toBeGreaterThan(0.03);
    expect(HAND_TOOL_GRIP_OFFSET.y).toBeLessThan(0.08);
    expect(HAND_TOOL_GRIP_OFFSET.z).toBe(0);

    // Measured idle frame-0 hand_R basis in Blender convention (+Z up, -Y forward) from survivor.glb
    const handX = new THREE.Vector3(0.721066, 0.635294, -0.276525).normalize();
    const handY = new THREE.Vector3(-0.011921, -0.387668, -0.921723).normalize();
    const handZ = new THREE.Vector3(-0.692764, 0.66792, -0.271961).normalize();
    const handBasis = new THREE.Matrix4().makeBasis(handX, handY, handZ);

    const localShaft = new THREE.Vector3(0, 1, 0).applyQuaternion(gripQuat);
    const localBlade = new THREE.Vector3(0, 0, -1).applyQuaternion(gripQuat);

    const worldShaft = localShaft.clone().applyMatrix4(handBasis);
    const worldBlade = localBlade.clone().applyMatrix4(handBasis);

    // Shaft (+Y) stands upright (+Z > 0.65) and blade edge (-Z) faces forward (-Y < -0.45, never backwards)
    expect(worldShaft.z).toBeGreaterThan(0.65);
    expect(worldBlade.y).toBeLessThan(-0.45);
  });
});
