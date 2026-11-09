/**
 * AvatarScene3D.jsx — Phiên bản Chrome Extension (100% Client-side, Zero-Remount)
 *
 * Sửa triệt để lỗi giật/reset mô hình 3D:
 * - Three.js Scene & WebGLRenderer chỉ khởi tạo ĐÚNG 1 LẦN khi mở Popup.
 * - Các callback (`onPlayingSign`, `onStatusChange`) được giữ trong `useRef` để
 *   không bao giờ kích hoạt `useEffect` khởi tạo lại cảnh 3D khi cha re-render
 *   (ví dụ khi gõ từng chữ cái vào ô input hoặc khi phụ đề cập nhật).
 */

import { useEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VrmHolisticRetargeter } from './vrm-holistic-retargeter';
import { resolveExtensionUrl } from '../../services/signEngine';

/* ==================== CONSTANTS ==================== */

const BONE_MAP = {
  thumb: { base: 'thumb_baseR', b01: 'thumb_01R', b02: 'thumb_02R', b03: 'thumb_03R' },
  index: { base: 'index_baseR', b01: 'index_01R', b02: 'index_02R', b03: 'index_03R' },
  middle: { base: 'middle_baseR', b01: 'middle_01R', b02: 'middle_02R', b03: 'middle_03R' },
  ring: { base: 'ring_baseR', b01: 'ring_01R', b02: 'ring_02R', b03: 'ring_03R' },
  pinky: { base: 'pinky_baseR', b01: 'pinky_01R', b02: 'pinky_02R', b03: 'pinky_03R' },
};

const FINGER_LM = {
  thumb: [0, 1, 2, 3, 4],
  index: [0, 5, 6, 7, 8],
  middle: [0, 9, 10, 11, 12],
  ring: [0, 13, 14, 15, 16],
  pinky: [0, 17, 18, 19, 20],
};

const FINGER_NAMES = Object.keys(FINGER_LM);
const BONE_KEYS = ['b01', 'b02', 'b03'];
const TRANSITION_DURATION = 0.16;
const PLAYBACK_SPEED_MULTIPLIER = 1.25;

/* ==================== PRE-ALLOCATED MATH OBJECTS ==================== */

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _v3d = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _quatTarget = new THREE.Quaternion();
const _mat4 = new THREE.Matrix4();

const _pts = Array.from({ length: 21 }, () => new THREE.Vector3());

const _curlAxisThumb = new THREE.Vector3(0.8, 0, 0.6).normalize();
const _curlAxisFinger = new THREE.Vector3(1, 0, 0);
const _splayAxis = new THREE.Vector3(0, 0, 1);

/* ==================== HELPER FUNCTIONS ==================== */

function collectBones(handModel) {
  const bones = {};
  handModel.traverse((node) => {
    if (!node.name) return;
    const cleanName = node.name.replace(/_0?\d{1,3}$/, '');
    for (const [finger, boneNames] of Object.entries(BONE_MAP)) {
      for (const [key, targetName] of Object.entries(boneNames)) {
        if (cleanName === targetName || node.name.startsWith(targetName + '_')) {
          bones[`${finger}_${key}`] = node;
        }
      }
    }
    if (cleanName === 'pulseR' || node.name.startsWith('pulseR_')) bones['wrist'] = node;
    if (cleanName === 'handR' || (node.name.startsWith('handR_') && !node.name.includes('001'))) {
      bones['hand'] = node;
    }
  });
  return bones;
}

function saveRestPose(bones) {
  const quats = {};
  for (const [key, bone] of Object.entries(bones)) {
    quats[key] = bone.quaternion.clone();
  }
  return quats;
}

function lerpLandmarks(a, b, t) {
  if (!a || !b) return a || b;
  return a.map((av, i) => {
    const bv = b[i] || av;
    return {
      x: av.x + (bv.x - av.x) * t,
      y: av.y + (bv.y - av.y) * t,
      z: (av.z || 0) + ((bv.z || 0) - (av.z || 0)) * t,
    };
  });
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function landmarksToPoints(landmarks) {
  for (let i = 0; i < 21; i++) {
    const lm = landmarks[i];
    _pts[i].set(lm.x - 0.5, -(lm.y - 0.5), -(lm.z || 0) * 0.5);
  }
  return _pts;
}

function applyHandLandmarks(bones, restQuats, landmarks) {
  if (!landmarks || landmarks.length < 21) return;

  const pts = landmarksToPoints(landmarks);

  const wristBone = bones['wrist'] || bones['hand'];
  if (wristBone) {
    _v3a.subVectors(pts[9], pts[0]).normalize();
    _v3b.subVectors(pts[17], pts[5]).normalize();
    _v3c.crossVectors(_v3a, _v3b).normalize();
    _v3d.crossVectors(_v3a, _v3c).normalize();

    _mat4.makeBasis(_v3d, _v3a, _v3c);
    _quatTarget.setFromRotationMatrix(_mat4);
    wristBone.quaternion.slerp(_quatTarget, 0.15);
  }

  for (let fi = 0; fi < FINGER_NAMES.length; fi++) {
    const fingerName = FINGER_NAMES[fi];
    const lmIndices = FINGER_LM[fingerName];

    for (let j = 0; j < 3; j++) {
      const boneKey = `${fingerName}_${BONE_KEYS[j]}`;
      const bone = bones[boneKey];
      if (!bone) continue;

      const restQ = restQuats[boneKey];
      if (!restQ) continue;

      _v3a.subVectors(pts[lmIndices[j]], pts[lmIndices[j + 1]]).normalize();
      _v3b.subVectors(pts[lmIndices[j + 2]], pts[lmIndices[j + 1]]).normalize();

      const straightAngle = _v3a.angleTo(_v3b);
      const bendAmount = Math.PI - straightAngle;
      const curlAxis = fingerName === 'thumb' ? _curlAxisThumb : _curlAxisFinger;
      const scaledBend = Math.min(Math.max(bendAmount * 1.2, 0), 2.2);

      _quat.setFromAxisAngle(curlAxis, scaledBend);
      _quatTarget.copy(restQ).multiply(_quat);
      bone.quaternion.slerp(_quatTarget, 0.5);
    }

    if (fingerName === 'thumb') continue;
    const baseBone = bones[`${fingerName}_base`];
    if (!baseBone) continue;
    const restBaseQ = restQuats[`${fingerName}_base`];
    if (!restBaseQ) continue;

    _v3a.subVectors(pts[9], pts[0]).normalize();
    _v3b.subVectors(pts[lmIndices[1]], pts[0]).normalize();
    _v3c.crossVectors(_v3a, _v3b);
    const splayAngle = _v3a.angleTo(_v3b) * Math.sign(_v3c.z) * 0.4;
    const clampedSplay = Math.min(Math.max(splayAngle, -0.3), 0.3);

    _quat.setFromAxisAngle(_splayAxis, clampedSplay);
    _quatTarget.copy(restBaseQ).multiply(_quat);
    baseBone.quaternion.slerp(_quatTarget, 0.3);
  }
}

function resetPose(sd) {
  if (!sd) return;
  if (sd.vrmRetargeter) {
    sd.vrmRetargeter.reset();
    return;
  }
  const restore = (bones, quats) => {
    if (!bones || !quats) return;
    for (const [key, quat] of Object.entries(quats)) {
      if (bones[key]) bones[key].quaternion.copy(quat);
    }
  };
  restore(sd.leftBones, sd.leftRestQuats);
  restore(sd.rightBones, sd.rightRestQuats);
  if (sd.leftHand) sd.leftHand.rotation.set(0, Math.PI, 0);
  if (sd.rightHand) sd.rightHand.rotation.set(0, 0, 0);
}

function disposeObject(obj, { disposeTextures = true } = {}) {
  if (!obj) return;
  obj.traverse((node) => {
    if (node.geometry) {
      node.geometry.dispose();
    }
    if (node.material) {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const mat of materials) {
        if (disposeTextures) {
          for (const key of Object.keys(mat)) {
            const value = mat[key];
            if (value && typeof value.dispose === 'function') {
              value.dispose();
            }
          }
        }
        mat.dispose();
      }
    }
  });
}

const ACCESSORY_MATERIALS = new Set([
  'backpack_metal',
  'backpack_nm',
  'backpack_plastic',
  'green_emit',
  'robo_face',
  'glass',
  'anim_logo',
  'arm_mat',
  'arm_plastic',
]);

function isAccessoryMaterial(material) {
  if (!material) return false;
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((mat) => ACCESSORY_MATERIALS.has((mat?.name || '').toLowerCase()));
}

function removeNonHumanAccessories(root) {
  const accessoryName = /(^|[_.-])(robo|robot|mecha|bagpack|backpack)([_.-]|$)/i;
  const accessories = [];

  root.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    if (accessoryName.test(node.name || '') || isAccessoryMaterial(node.material)) {
      accessories.push(node);
    }
  });

  for (const accessory of accessories) {
    accessory.removeFromParent();
    disposeObject(accessory, { disposeTextures: false });
  }
}

/* ==================== COMPONENT ==================== */

const AvatarScene3D = forwardRef(function AvatarScene3D(
  { className, style, onStatusChange, onPlayingSign, minimalUI = false },
  ref
) {
  const containerRef = useRef(null);
  const sceneDataRef = useRef(null);
  const rendererRef = useRef(null);
  const animFrameRef = useRef(null);

  // Giữ các callback ở trong ref để việc re-render của App (khi gõ phím, khi đồng bộ thời gian)
  // KHÔNG BAO GIỜ kích hoạt lại useEffect khởi tạo cảnh 3D.
  const callbacksRef = useRef({ onStatusChange, onPlayingSign });
  useEffect(() => {
    callbacksRef.current = { onStatusChange, onPlayingSign };
  }, [onStatusChange, onPlayingSign]);

  const animDataRef = useRef({
    queue: [],
    isPlaying: false,
    currentSign: null,
    currentFrames: null,
    currentFrameIdx: 0,
    currentFps: 25,
    frameTimer: 0,
    isTransitioning: false,
    transitionProgress: 0,
    prevLeftLandmarks: null,
    prevRightLandmarks: null,
    pendingCount: 0,
    awaitingData: false,
    runId: 0,
  });

  const landmarkCacheRef = useRef(new Map());
  const playNextRef = useRef(null);

  const [status, setStatus] = useState('Đang tải mô hình 3D...');
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [currentGloss, setCurrentGloss] = useState(null);

  const updateStatus = useCallback((text) => {
    setStatus(text);
    callbacksRef.current.onStatusChange?.(text);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    setIsModelLoaded(false);

    const scene = new THREE.Scene();
    const clock = new THREE.Clock();

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      const w = Math.max(container.clientWidth, 1);
      const h = Math.max(container.clientHeight, 1);
      renderer.setSize(w, h);
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;
    } catch {
      setLoadError('WebGL không khởi tạo được.');
      return;
    }

    const onContextLost = (e) => {
      e.preventDefault();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
    const onContextRestored = () => {
      if (!disposed) animate();
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

    const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1);
    const camera = new THREE.PerspectiveCamera(36, aspect, 0.05, 50);
    camera.position.set(0, 0.52, 1.32);
    camera.lookAt(0, 0.38, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const hemi = new THREE.HemisphereLight(0xe8f4ff, 0x8eaacc, 0.75);
    hemi.position.set(0, 2, 0);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2.5, 3, 2.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xb7d7ff, 0.9);
    fill.position.set(-2.5, 2, 1.5);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(0x88ddff, 0.7);
    rim.position.set(0, 1.5, -3);
    scene.add(rim);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;
    pmrem.dispose();

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.38, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.5;
    controls.maxDistance = 3.5;
    controls.maxPolarAngle = Math.PI * 0.65;
    controls.minPolarAngle = Math.PI * 0.15;
    controls.update();

    scene.background = new THREE.Color(0xefece0);

    const floorGeo = new THREE.CircleGeometry(2, 48);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0xe2dec9,
      roughness: 0.75,
      metalness: 0.08,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const ringGeo = new THREE.TorusGeometry(0.68, 0.009, 8, 48);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x325825,
      emissive: 0x307436,
      emissiveIntensity: 0.25,
      roughness: 0.5,
      metalness: 0.1,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.005;
    scene.add(ring);

    const grid = new THREE.GridHelper(3, 18, 0xc7bfa8, 0xdad4c0);
    grid.position.y = 0.001;
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    scene.add(grid);

    async function loadFallbackHands() {
      const loader = new GLTFLoader();
      const handUrl = resolveExtensionUrl('models/rigged_hand.glb');
      const gltf = await loader.loadAsync(handUrl);
      if (disposed) return;

      const original = gltf.scene;
      const box = new THREE.Box3().setFromObject(original);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scaleFactor = 0.45 / maxDim;

      const mainMat = new THREE.MeshPhysicalMaterial({
        color: 0xd8e2ec,
        metalness: 0.75,
        roughness: 0.2,
        clearcoat: 0.8,
        clearcoatRoughness: 0.1,
        envMapIntensity: 1.5,
      });

      function applyMaterial(model) {
        model.traverse((node) => {
          if (!node.isMesh) return;
          node.material = mainMat;
          node.castShadow = true;
          node.receiveShadow = true;
          node.frustumCulled = false;
        });
      }

      const leftHand = SkeletonUtils.clone(original);
      leftHand.name = 'left_hand';
      leftHand.scale.setScalar(scaleFactor);
      leftHand.position.set(-0.22, 0.35, 0.05);
      leftHand.rotation.set(0, Math.PI, 0);
      applyMaterial(leftHand);
      scene.add(leftHand);

      const rightHand = SkeletonUtils.clone(original);
      rightHand.name = 'right_hand';
      rightHand.scale.setScalar(scaleFactor);
      rightHand.position.set(0.22, 0.35, 0.05);
      rightHand.rotation.set(0, 0, 0);
      applyMaterial(rightHand);
      scene.add(rightHand);

      leftHand.updateMatrixWorld(true);
      rightHand.updateMatrixWorld(true);

      const leftBones = collectBones(leftHand);
      const rightBones = collectBones(rightHand);

      sceneDataRef.current = {
        leftHand,
        rightHand,
        leftBones,
        rightBones,
        leftRestQuats: saveRestPose(leftBones),
        rightRestQuats: saveRestPose(rightBones),
        mainMat,
      };

      setIsModelLoaded(true);
      updateStatus('Mô hình 2 bàn tay 3D sẵn sàng');
    }

    async function loadVrmAvatar() {
      const vrmUrl = resolveExtensionUrl('models/avatar.vrm');
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(vrmUrl);
      if (disposed) return true;

      const vrm = gltf.userData.vrm;
      if (!vrm) throw new Error('avatar.vrm lacks VRM metadata');

      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(vrm);

      removeNonHumanAccessories(vrm.scene);

      const box = new THREE.Box3().setFromObject(vrm.scene);
      const size = box.getSize(new THREE.Vector3());
      vrm.scene.scale.setScalar(1.35 / Math.max(size.y, 0.01));
      vrm.scene.position.set(0, 0, 0);
      vrm.scene.traverse((node) => {
        if (!node.isMesh) return;
        node.castShadow = true;
        node.receiveShadow = true;
        node.frustumCulled = false;
      });
      scene.add(vrm.scene);
      vrm.scene.updateMatrixWorld(true);

      sceneDataRef.current = {
        vrm,
        vrmRetargeter: new VrmHolisticRetargeter(vrm),
      };
      setIsModelLoaded(true);
      updateStatus('Nhân vật 3D toàn thân sẵn sàng');
      return true;
    }

    loadVrmAvatar().catch((err) => {
      console.error('[AvatarScene3D] Lỗi tải nhân vật 3D:', err);
      setLoadError('Không tải được mô hình nhân vật 3D.');
    });

    function playNextInQueue() {
      const anim = animDataRef.current;
      const sd = sceneDataRef.current;

      if (sd && anim.queue.length === 0 && anim.pendingCount > 0) {
        anim.awaitingData = true;
        anim.currentFrames = null;
        anim.currentFrameIdx = 0;
        anim.frameTimer = 0;
        updateStatus('Đang chuẩn bị động tác tiếp theo...');
        return;
      }

      if (!sd || anim.queue.length === 0) {
        anim.isPlaying = false;
        anim.awaitingData = false;
        anim.currentFrames = null;
        anim.currentSign = null;
        anim.currentFrameIdx = 0;
        anim.frameTimer = 0;
        resetPose(sd);
        setCurrentGloss(null);
        updateStatus('Sẵn sàng phiên dịch');
        callbacksRef.current.onPlayingSign?.(null);
        return;
      }

      anim.awaitingData = false;
      anim.isPlaying = true;
      const current = anim.queue.shift();
      anim.currentSign = current;
      anim.currentFrames = current.data.frames;
      anim.currentFps = (current.data.fps || 25) * PLAYBACK_SPEED_MULTIPLIER;
      anim.currentFrameIdx = 0;
      anim.frameTimer = 0;
      anim.isTransitioning = true;
      anim.transitionProgress = 0;

      const label = `Đang ký: ${current.vi} (${current.gloss.toUpperCase()})`;
      updateStatus(label);
      setCurrentGloss(current.gloss);
      callbacksRef.current.onPlayingSign?.(current);
    }

    playNextRef.current = playNextInQueue;

    function updateAnimation(delta) {
      const anim = animDataRef.current;
      const sd = sceneDataRef.current;
      if (!anim.isPlaying || !anim.currentFrames || !sd) return;

      if (anim.isTransitioning) {
        anim.transitionProgress += delta / TRANSITION_DURATION;
        if (anim.transitionProgress >= 1) {
          anim.isTransitioning = false;
          anim.transitionProgress = 1;
        }
        if (anim.currentFrames.length > 0) {
          const firstFrame = anim.currentFrames[0];
          const t = easeInOutCubic(Math.min(anim.transitionProgress, 1));
          if (sd.vrmRetargeter) {
            sd.vrmRetargeter.apply(firstFrame, delta);
          } else if (firstFrame.left_hand) {
            const from = anim.prevLeftLandmarks || firstFrame.left_hand;
            applyHandLandmarks(
              sd.leftBones,
              sd.leftRestQuats,
              lerpLandmarks(from, firstFrame.left_hand, t)
            );
          }
          if (!sd.vrmRetargeter && firstFrame.right_hand) {
            const from = anim.prevRightLandmarks || firstFrame.right_hand;
            applyHandLandmarks(
              sd.rightBones,
              sd.rightRestQuats,
              lerpLandmarks(from, firstFrame.right_hand, t)
            );
          }
        }
        return;
      }

      anim.frameTimer += delta;
      const frameDuration = 1 / anim.currentFps;

      if (anim.frameTimer >= frameDuration) {
        anim.frameTimer -= frameDuration;
        anim.currentFrameIdx++;

        if (anim.currentFrameIdx >= anim.currentFrames.length) {
          const lastFrame = anim.currentFrames[anim.currentFrames.length - 1];
          anim.prevLeftLandmarks = lastFrame?.left_hand || null;
          anim.prevRightLandmarks = lastFrame?.right_hand || null;
          playNextInQueue();
          return;
        }
      }

      const frame = anim.currentFrames[anim.currentFrameIdx];
      if (!frame) return;

      const nextIdx = Math.min(anim.currentFrameIdx + 1, anim.currentFrames.length - 1);
      const nextFrame = anim.currentFrames[nextIdx];
      const t = anim.frameTimer / frameDuration;

      if (sd.vrmRetargeter) {
        sd.vrmRetargeter.apply(
          {
            ...frame,
            pose: lerpLandmarks(frame.pose, nextFrame?.pose || frame.pose, t),
            pose_world: lerpLandmarks(
              frame.pose_world,
              nextFrame?.pose_world || frame.pose_world,
              t
            ),
            left_hand: lerpLandmarks(frame.left_hand, nextFrame?.left_hand || frame.left_hand, t),
            right_hand: lerpLandmarks(
              frame.right_hand,
              nextFrame?.right_hand || frame.right_hand,
              t
            ),
          },
          delta
        );
      } else if (frame.left_hand) {
        applyHandLandmarks(
          sd.leftBones,
          sd.leftRestQuats,
          lerpLandmarks(frame.left_hand, nextFrame?.left_hand || frame.left_hand, t)
        );
      }
      if (!sd.vrmRetargeter && frame.right_hand) {
        applyHandLandmarks(
          sd.rightBones,
          sd.rightRestQuats,
          lerpLandmarks(frame.right_hand, nextFrame?.right_hand || frame.right_hand, t)
        );
      }
    }

    function animate() {
      if (disposed) return;
      animFrameRef.current = requestAnimationFrame(animate);

      const delta = clock.getDelta();
      controls.update();
      updateAnimation(delta);
      renderer.render(scene, camera);
    }

    animate();

    let lastW = 0,
      lastH = 0;
    let resizeRafId = null;
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      if (resizeRafId) cancelAnimationFrame(resizeRafId);
      resizeRafId = requestAnimationFrame(() => {
        if (!container || !renderer || !camera || disposed) return;
        const w = Math.max(container.clientWidth, 1);
        const h = Math.max(container.clientHeight, 1);
        if (w === lastW && h === lastH) return;
        lastW = w;
        lastH = h;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      });
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);

      disposeObject(scene);
      if (envTexture) envTexture.dispose();

      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();

      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }

      rendererRef.current = null;
      sceneDataRef.current = null;
    };
  }, [updateStatus]);

  /* ---------- Load Landmarks Directly from Bundled Extension Files ---------- */
  const loadLandmarks = useCallback(async (sign) => {
    const glossKey = (sign.gloss || '').toLowerCase().trim();
    if (!glossKey) return null;

    const cache = landmarkCacheRef.current;
    const cached = cache.get(glossKey);
    if (cached) {
      const data = await cached;
      return data ? { gloss: glossKey, vi: sign.vi, data } : null;
    }

    const request = (async () => {
      const fileUrl = resolveExtensionUrl(`data/landmarks_v2/${encodeURIComponent(glossKey)}.json`);
      const resp = await fetch(fileUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data?.frames?.length) throw new Error('empty landmark frames');
      return data;
    })();

    cache.set(glossKey, request);
    try {
      const data = await request;
      cache.set(glossKey, data);
      return { gloss: glossKey, vi: sign.vi, data };
    } catch (err) {
      cache.delete(glossKey);
      throw err;
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      preloadSigns(signs) {
        for (const sign of signs || []) {
          if (sign?.found && sign?.gloss) {
            loadLandmarks(sign).catch(() => {});
          }
        }
      },

      async playSignSequence(signs) {
        const sd = sceneDataRef.current;
        if (!sd) return;

        const foundSigns = (signs || []).filter((s) => s.found && s.gloss);
        if (foundSigns.length === 0) return;

        const anim = animDataRef.current;
        const runId = anim.runId + 1;
        anim.runId = runId;
        anim.queue = [];
        anim.pendingCount = foundSigns.length;
        anim.awaitingData = false;

        const requests = foundSigns.map((sign) => loadLandmarks(sign));

        for (const request of requests) {
          let loaded = null;
          try {
            loaded = await request;
          } catch (err) {
            console.warn('[Avatar3D] Không tìm thấy file landmark:', err);
          }

          if (anim.runId !== runId) return;

          anim.pendingCount -= 1;
          if (!loaded) continue;

          anim.queue.push(loaded);
          if (!anim.isPlaying || anim.awaitingData) {
            playNextRef.current?.();
          }
        }

        if (anim.runId !== runId) return;

        if (anim.awaitingData && anim.queue.length === 0) {
          playNextRef.current?.();
        }
      },

      stopAnimation() {
        const anim = animDataRef.current;
        anim.runId += 1;
        anim.isPlaying = false;
        anim.pendingCount = 0;
        anim.awaitingData = false;
        anim.queue = [];
        anim.currentFrames = null;
        anim.currentSign = null;
        anim.currentFrameIdx = 0;
        anim.frameTimer = 0;
        anim.isTransitioning = false;
        resetPose(sceneDataRef.current);
        setCurrentGloss(null);
        updateStatus('Sẵn sàng phiên dịch');
      },

      get isModelLoaded() {
        return isModelLoaded;
      },
    }),
    [isModelLoaded, updateStatus, loadLandmarks]
  );

  if (loadError) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#EFECE0',
          borderRadius: '12px',
        }}
      >
        <p style={{ color: '#5F2A1A', fontSize: '13px', textAlign: 'center', padding: '16px' }}>
          ❌ {loadError}
        </p>
      </div>
    );
  }

  return (
      <div
        ref={containerRef}
        className={className}
        style={{
          width: '100%',
          height: '100%',
          borderRadius: minimalUI ? '0px' : '12px',
          overflow: 'hidden',
          position: 'relative',
          ...style,
        }}
      >
        {!isModelLoaded && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255, 252, 237, 0.94)',
              zIndex: 2,
            }}
          >
            <div className="avatar-loader" />
            <p
              style={{
                color: '#325825',
                fontSize: '12px',
                fontWeight: 600,
                marginTop: '10px',
              }}
            >
              Đang nạp mô hình ngôn ngữ ký hiệu 3D...
            </p>
          </div>
        )}

        {!minimalUI && (
          <div
            style={{
              position: 'absolute',
              bottom: '8px',
              left: '8px',
              right: '8px',
              padding: '6px 12px',
              background: 'rgba(232, 230, 218, 0.92)',
              backdropFilter: 'blur(6px)',
              borderRadius: '60px',
              border: '1px solid rgba(75, 45, 21, 0.14)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              zIndex: 1,
              pointerEvents: 'none',
            }}
          >
            <span style={{ color: '#4B2D15', fontSize: '11.5px', fontWeight: 600 }}>{status}</span>
            {currentGloss && (
              <span
                style={{
                  padding: '2px 10px',
                  background: '#325825',
                  borderRadius: '100px',
                  color: '#FFFCED',
                  fontSize: '10.5px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.4px',
                }}
              >
                {currentGloss}
              </span>
            )}
          </div>
        )}
      </div>
  );
});

export default AvatarScene3D;
