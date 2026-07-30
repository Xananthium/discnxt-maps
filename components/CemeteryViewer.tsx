"use client";

import Script from "next/script";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { PublicMapEpoch } from "../lib/mapEpochs.mjs";

export interface ViewerConfig {
  boundaryUrl: string;
  cesiumScriptUrl: string;
  epochs: readonly PublicMapEpoch[];
}

type AssetPhase =
  | "idle"
  | "loading"
  | "streaming"
  | "ready"
  | "unavailable"
  | "blocked"
  | "error";
type BookmarkId = "overview" | "north-oblique" | "south-oblique" | "east-edge";
type QualityId = "lite" | "balanced" | "ultra";

interface CameraPreset {
  id: BookmarkId;
  label: string;
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
}

interface CameraReadout {
  longitude: number;
  latitude: number;
  height: number;
  x: number;
  y: number;
  z: number;
}

interface MeasurementResult {
  distance: number;
  pointA: CameraReadout;
  pointB: CameraReadout;
}

const CAMERA_PRESETS: readonly CameraPreset[] = [
  {
    id: "overview",
    label: "Overview",
    longitude: -80.0383468799,
    latitude: 40.4480824487,
    height: 520,
    heading: 0,
    pitch: -90
  },
  {
    id: "north-oblique",
    label: "North oblique",
    longitude: -80.03835,
    latitude: 40.4501,
    height: 430,
    heading: 180,
    pitch: -31
  },
  {
    id: "south-oblique",
    label: "South oblique",
    longitude: -80.03835,
    latitude: 40.44615,
    height: 430,
    heading: 0,
    pitch: -31
  },
  {
    id: "east-edge",
    label: "East edge",
    longitude: -80.03555,
    latitude: 40.44805,
    height: 420,
    heading: 270,
    pitch: -27
  }
] as const;

const QUALITY_SETTINGS: Record<
  QualityId,
  { label: string; maximumScreenSpaceError: number; resolutionScale: number }
> = {
  lite: {
    label: "Lite",
    maximumScreenSpaceError: 24,
    resolutionScale: 0.75
  },
  balanced: {
    label: "Balanced",
    maximumScreenSpaceError: 12,
    resolutionScale: 1
  },
  ultra: {
    label: "Ultra",
    maximumScreenSpaceError: 6,
    resolutionScale: 1.35
  }
};

const FIXED_SCENE_TIME = "2026-07-29T18:00:00Z";
const MEASUREMENT_ENTITY_PREFIX = "metric-measurement-";

function isBookmark(value: string | null): value is BookmarkId {
  return CAMERA_PRESETS.some((preset) => preset.id === value);
}

function isQuality(value: string | null): value is QualityId {
  return value === "lite" || value === "balanced" || value === "ultra";
}

function statusLabel(status: AssetPhase): string {
  const labels: Record<AssetPhase, string> = {
    idle: "Idle",
    loading: "Loading",
    streaming: "Streaming first tile",
    ready: "Ready",
    unavailable: "Not configured",
    blocked: "Blocked by release gate",
    error: "Error"
  };
  return labels[status];
}

function toReadout(Cesium: any, position: any): CameraReadout {
  const cartographic = Cesium.Cartographic.fromCartesian(position);
  return {
    longitude: Cesium.Math.toDegrees(cartographic.longitude),
    latitude: Cesium.Math.toDegrees(cartographic.latitude),
    height: cartographic.height,
    x: position.x,
    y: position.y,
    z: position.z
  };
}

function belongsToTileset(picked: any, tileset: any): boolean {
  if (!picked || !tileset) {
    return false;
  }
  return (
    picked === tileset ||
    picked.primitive === tileset ||
    picked.tileset === tileset ||
    picked.content?.tileset === tileset ||
    picked.primitive?.tileset === tileset
  );
}

function removeTileset(viewer: any, tileset: any): void {
  if (!tileset) {
    return;
  }
  if (viewer && !viewer.isDestroyed?.()) {
    const removed = viewer.scene.primitives.remove(tileset);
    if (removed) {
      return;
    }
  }
  if (!tileset.isDestroyed?.()) {
    tileset.destroy?.();
  }
}

export default function CemeteryViewer({ config }: { config: ViewerConfig }) {
  const defaultEpoch = config.epochs.at(-1);
  if (!defaultEpoch) {
    throw new Error("At least one fail-closed map epoch is required.");
  }

  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const tilesetRef = useRef<any>(null);
  const measurementHandlerRef = useRef<any>(null);
  const measurementPointsRef = useRef<any[]>([]);
  const flyKeysRef = useRef<Set<string>>(new Set());
  const flyFrameRef = useRef<number | null>(null);
  const flyActiveRef = useRef(false);
  const currentBookmarkRef = useRef<BookmarkId>("overview");
  const currentQualityRef = useRef<QualityId>("balanced");

  const [engineStatus, setEngineStatus] = useState<AssetPhase>("loading");
  const [boundaryStatus, setBoundaryStatus] = useState<AssetPhase>("idle");
  const [modelStatus, setModelStatus] = useState<AssetPhase>("idle");
  const [modelDetail, setModelDetail] = useState(defaultEpoch.modelStatusLabel);
  const [runtimeError, setRuntimeError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [bookmark, setBookmark] = useState<BookmarkId>("overview");
  const [quality, setQuality] = useState<QualityId>("balanced");
  const [selectedEpochId, setSelectedEpochId] = useState(defaultEpoch.id);
  const [urlStateResolved, setUrlStateResolved] = useState(false);
  const [flyActive, setFlyActive] = useState(false);
  const [measurementEnabled, setMeasurementEnabled] = useState(false);
  const [measurementHint, setMeasurementHint] = useState(
    "Load an approved metric tileset to enable distance measurement."
  );
  const [measurement, setMeasurement] = useState<MeasurementResult | null>(null);
  const [cameraReadout, setCameraReadout] = useState<CameraReadout | null>(null);

  const selectedEpoch = useMemo(
    () =>
      config.epochs.find((epoch) => epoch.id === selectedEpochId) ??
      defaultEpoch,
    [config.epochs, defaultEpoch, selectedEpochId]
  );
  const releaseGateOpen =
    selectedEpoch.publicReleaseApproved && selectedEpoch.privacyCropVerified;
  const metricConfigured = selectedEpoch.metricTilesetUrl.length > 0;
  const metricPermitted = metricConfigured && releaseGateOpen;
  const shellReady = boundaryStatus === "ready" && engineStatus === "ready";
  const metricReady = modelStatus === "ready";

  const releaseGateMessage = useMemo(() => {
    if (!metricConfigured) {
      return `${selectedEpoch.modelStatusLabel} No public metric tileset is configured for this epoch; boundary-only preview is active.`;
    }
    if (
      !selectedEpoch.publicReleaseApproved &&
      !selectedEpoch.privacyCropVerified
    ) {
      return `Epoch ${selectedEpoch.id} is blocked: release approval and privacy-crop verification are both absent.`;
    }
    if (!selectedEpoch.publicReleaseApproved) {
      return `Epoch ${selectedEpoch.id} is blocked: public release approval is absent.`;
    }
    if (!selectedEpoch.privacyCropVerified) {
      return `Epoch ${selectedEpoch.id} is blocked: privacy-crop verification is absent.`;
    }
    return `Release and privacy gates are open for epoch ${selectedEpoch.id}.`;
  }, [
    metricConfigured,
    selectedEpoch.id,
    selectedEpoch.modelStatusLabel,
    selectedEpoch.privacyCropVerified,
    selectedEpoch.publicReleaseApproved
  ]);

  const clearMeasurementEntities = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed?.()) {
      return;
    }
    const toRemove = viewer.entities.values.filter((entity: any) =>
      String(entity.id).startsWith(MEASUREMENT_ENTITY_PREFIX)
    );
    for (const entity of toRemove) {
      viewer.entities.remove(entity);
    }
    measurementPointsRef.current = [];
  }, []);

  const updateUrlState = useCallback(
    (
      nextBookmark: BookmarkId,
      nextQuality: QualityId,
      nextEpochId: string
    ) => {
      const url = new URL(window.location.href);
      url.searchParams.set("bookmark", nextBookmark);
      url.searchParams.set("quality", nextQuality);
      url.searchParams.set("epoch", nextEpochId);
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    },
    []
  );

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const queryBookmark = query.get("bookmark");
    const queryQuality = query.get("quality");
    const queryEpoch = query.get("epoch");
    const initialBookmark: BookmarkId = isBookmark(queryBookmark)
      ? queryBookmark
      : "overview";
    const initialQuality: QualityId = isQuality(queryQuality)
      ? queryQuality
      : "balanced";
    const initialEpoch = config.epochs.some((epoch) => epoch.id === queryEpoch)
      ? (queryEpoch as string)
      : defaultEpoch.id;

    currentBookmarkRef.current = initialBookmark;
    currentQualityRef.current = initialQuality;
    setBookmark(initialBookmark);
    setQuality(initialQuality);
    setSelectedEpochId(initialEpoch);
    updateUrlState(initialBookmark, initialQuality, initialEpoch);
    setUrlStateResolved(true);
  }, [config.epochs, defaultEpoch.id, updateUrlState]);

  const applyQuality = useCallback((nextQuality: QualityId) => {
    const viewer = viewerRef.current;
    currentQualityRef.current = nextQuality;
    setQuality(nextQuality);
    if (viewer && !viewer.isDestroyed?.()) {
      viewer.resolutionScale = QUALITY_SETTINGS[nextQuality].resolutionScale;
      viewer.scene.requestRender?.();
    }
    if (tilesetRef.current) {
      tilesetRef.current.maximumScreenSpaceError =
        QUALITY_SETTINGS[nextQuality].maximumScreenSpaceError;
    }
  }, []);

  const applyBookmark = useCallback((nextBookmark: BookmarkId) => {
    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    const preset = CAMERA_PRESETS.find((candidate) => candidate.id === nextBookmark);
    if (!viewer || !Cesium || !preset || viewer.isDestroyed?.()) {
      return;
    }
    currentBookmarkRef.current = nextBookmark;
    setBookmark(nextBookmark);
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        preset.longitude,
        preset.latitude,
        preset.height
      ),
      orientation: {
        heading: Cesium.Math.toRadians(preset.heading),
        pitch: Cesium.Math.toRadians(preset.pitch),
        roll: 0
      }
    });
    viewer.scene.requestRender?.();
  }, []);

  const destroyViewer = useCallback(() => {
    measurementHandlerRef.current?.destroy?.();
    measurementHandlerRef.current = null;
    tilesetRef.current = null;
    measurementPointsRef.current = [];
    if (viewerRef.current && !viewerRef.current.isDestroyed?.()) {
      viewerRef.current.destroy();
    }
    viewerRef.current = null;
    if (containerRef.current) {
      containerRef.current.replaceChildren();
    }
  }, []);

  const initializeViewer = useCallback(async () => {
    const Cesium = window.Cesium;
    const container = containerRef.current;
    if (!Cesium || !container) {
      return () => undefined;
    }

    destroyViewer();
    setRuntimeError("");
    setBoundaryStatus("loading");
    setMeasurementEnabled(false);
    setMeasurement(null);
    setMeasurementHint(
      "Load an approved metric tileset to enable distance measurement."
    );
    setModelStatus("idle");
    setModelDetail("Waiting for the selected map epoch.");

    let disposed = false;
    let removeCameraListener: (() => void) | undefined;

    try {
      const viewer = new Cesium.Viewer(container, {
        animation: false,
        baseLayer: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        navigationHelpButton: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        terrainProvider: new Cesium.EllipsoidTerrainProvider()
      });
      viewerRef.current = viewer;
      viewer.imageryLayers.removeAll(true);
      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#06100d");
      viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#102820");
      viewer.scene.globe.showGroundAtmosphere = false;
      viewer.scene.skyAtmosphere.show = false;
      viewer.scene.fog.enabled = false;
      viewer.scene.screenSpaceCameraController.minimumZoomDistance = 2;
      viewer.scene.screenSpaceCameraController.maximumZoomDistance = 2_500_000;
      viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(FIXED_SCENE_TIME);
      viewer.clock.shouldAnimate = false;

      const initialBookmark = currentBookmarkRef.current;
      const initialQuality = currentQualityRef.current;
      applyQuality(initialQuality);

      const updateCameraReadout = () => {
        if (!viewer.isDestroyed?.()) {
          setCameraReadout(toReadout(Cesium, viewer.camera.positionWC));
        }
      };
      updateCameraReadout();
      removeCameraListener = viewer.camera.changed.addEventListener(
        updateCameraReadout
      );

      const boundaryTask = (async () => {
        try {
          const boundary = await Cesium.GeoJsonDataSource.load(
            config.boundaryUrl,
            {
              clampToGround: true,
              fill: Cesium.Color.fromCssColorString("#5ef2ad").withAlpha(0.12),
              stroke: Cesium.Color.fromCssColorString("#73ffc1"),
              strokeWidth: 3
            }
          );
          if (disposed || viewer.isDestroyed?.()) {
            return;
          }
          await viewer.dataSources.add(boundary);
          for (const entity of boundary.entities.values) {
            if (entity.polygon) {
              entity.polygon.material =
                Cesium.Color.fromCssColorString("#5ef2ad").withAlpha(0.12);
              entity.polygon.outline = true;
              entity.polygon.outlineColor =
                Cesium.Color.fromCssColorString("#73ffc1");
            }
          }
          setBoundaryStatus("ready");
        } catch (error) {
          if (!disposed) {
            setBoundaryStatus("error");
            setRuntimeError(
              `Boundary failed to load: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      })();

      await Promise.allSettled([boundaryTask]);
      if (!disposed && !viewer.isDestroyed?.()) {
        applyBookmark(initialBookmark);
      }
    } catch (error) {
      if (!disposed) {
        setEngineStatus("error");
        setRuntimeError(
          `Cesium viewer initialization failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return () => {
      disposed = true;
      removeCameraListener?.();
    };
  }, [
    applyBookmark,
    applyQuality,
    config.boundaryUrl,
    destroyViewer
  ]);

  useEffect(() => {
    if (engineStatus !== "ready") {
      return;
    }
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void initializeViewer().then((nextCleanup) => {
      if (cancelled) {
        nextCleanup();
        destroyViewer();
      } else {
        cleanup = nextCleanup;
      }
    });
    return () => {
      cancelled = true;
      cleanup?.();
      destroyViewer();
    };
  }, [destroyViewer, engineStatus, initializeViewer, reloadToken]);

  useEffect(() => {
    if (
      !urlStateResolved ||
      engineStatus !== "ready" ||
      boundaryStatus !== "ready"
    ) {
      return;
    }

    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    if (!viewer || !Cesium || viewer.isDestroyed?.()) {
      return;
    }

    let disposed = false;
    let loadedTileset: any = null;
    let removeTileVisibleListener: (() => void) | undefined;

    measurementHandlerRef.current?.destroy?.();
    measurementHandlerRef.current = null;
    clearMeasurementEntities();
    setMeasurementEnabled(false);
    setMeasurement(null);
    setMeasurementHint(
      "Load an approved metric tileset to enable distance measurement."
    );
    setRuntimeError("");

    const previousTileset = tilesetRef.current;
    tilesetRef.current = null;
    removeTileset(viewer, previousTileset);

    setModelStatus(
      !metricConfigured ? "unavailable" : metricPermitted ? "loading" : "blocked"
    );
    setModelDetail(releaseGateMessage);

    if (metricPermitted) {
      void (async () => {
        try {
          const tileset = await Cesium.Cesium3DTileset.fromUrl(
            selectedEpoch.metricTilesetUrl,
            {
              maximumScreenSpaceError:
                QUALITY_SETTINGS[currentQualityRef.current]
                  .maximumScreenSpaceError
            }
          );
          if (disposed || viewer.isDestroyed?.()) {
            tileset.destroy?.();
            return;
          }

          loadedTileset = tileset;
          tilesetRef.current = tileset;
          viewer.scene.primitives.add(tileset);
          setModelStatus("streaming");
          setModelDetail(
            `Epoch ${selectedEpoch.id} metadata loaded; waiting for its first visible metric tile.`
          );
          removeTileVisibleListener = tileset.tileVisible.addEventListener(() => {
            if (!disposed && tilesetRef.current === tileset) {
              setModelStatus("ready");
              setModelDetail(
                `Epoch ${selectedEpoch.id} is visible. Mesh-surface distance measurement is enabled for this epoch.`
              );
              setMeasurementHint(
                "Select Measure distance, then click two points on the metric mesh."
              );
              removeTileVisibleListener?.();
              removeTileVisibleListener = undefined;
            }
          });
        } catch (error) {
          if (!disposed) {
            setModelStatus("error");
            setModelDetail(
              `Epoch ${selectedEpoch.id} metric tileset could not be loaded.`
            );
            setRuntimeError(
              `Metric tileset for epoch ${selectedEpoch.id} failed to load: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      })();
    }

    return () => {
      disposed = true;
      removeTileVisibleListener?.();
      if (tilesetRef.current === loadedTileset) {
        tilesetRef.current = null;
      }
      removeTileset(viewer, loadedTileset);
    };
  }, [
    boundaryStatus,
    clearMeasurementEntities,
    engineStatus,
    metricConfigured,
    metricPermitted,
    releaseGateMessage,
    reloadToken,
    selectedEpoch.id,
    selectedEpoch.metricTilesetUrl,
    urlStateResolved
  ]);

  useEffect(() => {
    measurementHandlerRef.current?.destroy?.();
    measurementHandlerRef.current = null;
    clearMeasurementEntities();
    setMeasurement(null);

    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    const tileset = tilesetRef.current;
    if (
      !measurementEnabled ||
      !metricReady ||
      !viewer ||
      !Cesium ||
      !tileset ||
      viewer.isDestroyed?.()
    ) {
      return;
    }

    setMeasurementHint("Click the first point on the metric mesh.");
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    measurementHandlerRef.current = handler;
    handler.setInputAction((movement: any) => {
      const picked = viewer.scene.drillPick(movement.position, 20);
      if (!picked.some((candidate: any) => belongsToTileset(candidate, tileset))) {
        setMeasurementHint(
          "That point is not on the approved metric tileset. Choose the visible mesh."
        );
        return;
      }
      if (!viewer.scene.pickPositionSupported) {
        setMeasurementHint("This browser does not support depth-position picking.");
        return;
      }
      const point = viewer.scene.pickPosition(movement.position);
      if (!Cesium.defined(point)) {
        setMeasurementHint("No metric surface position was resolved. Try again.");
        return;
      }

      measurementPointsRef.current.push(point);
      const index = measurementPointsRef.current.length;
      viewer.entities.add({
        id: `${MEASUREMENT_ENTITY_PREFIX}point-${index}`,
        position: point,
        point: {
          color: Cesium.Color.fromCssColorString(index === 1 ? "#ffcc66" : "#5ef2ad"),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          pixelSize: 11,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });

      if (index === 1) {
        setMeasurementHint("First point set. Click a second point on the metric mesh.");
        return;
      }

      const [pointA, pointB] = measurementPointsRef.current;
      const distance = Cesium.Cartesian3.distance(pointA, pointB);
      viewer.entities.add({
        id: `${MEASUREMENT_ENTITY_PREFIX}segment`,
        polyline: {
          positions: [pointA, pointB],
          width: 4,
          material: Cesium.Color.fromCssColorString("#ffcc66"),
          depthFailMaterial: Cesium.Color.fromCssColorString("#ffcc66").withAlpha(0.45)
        }
      });
      setMeasurement({
        distance,
        pointA: toReadout(Cesium, pointA),
        pointB: toReadout(Cesium, pointB)
      });
      setMeasurementHint(
        "Distance resolved in ECEF metres from two metric-mesh surface picks."
      );
      measurementHandlerRef.current?.destroy?.();
      measurementHandlerRef.current = null;
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    return () => {
      if (measurementHandlerRef.current === handler) {
        handler.destroy();
        measurementHandlerRef.current = null;
      }
    };
  }, [
    clearMeasurementEntities,
    measurementEnabled,
    metricReady,
    reloadToken
  ]);

  useEffect(() => {
    const setCesiumControls = (enabled: boolean) => {
      const controller =
        viewerRef.current?.scene?.screenSpaceCameraController;
      if (!controller) {
        return;
      }
      controller.enableRotate = enabled;
      controller.enableTranslate = enabled;
      controller.enableZoom = enabled;
      controller.enableTilt = enabled;
      controller.enableLook = enabled;
    };

    const onPointerLockChange = () => {
      const canvas = viewerRef.current?.scene?.canvas;
      const active = Boolean(canvas && document.pointerLockElement === canvas);
      flyActiveRef.current = active;
      setFlyActive(active);
      setCesiumControls(!active);
      if (!active) {
        flyKeysRef.current.clear();
      }
    };
    const onPointerLockError = () => {
      setRuntimeError(
        "Fly mode could not acquire pointer lock. Use the preset cameras or browser orbit controls."
      );
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!flyActiveRef.current) {
        return;
      }
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "q", "e", "shift"].includes(key)) {
        event.preventDefault();
        flyKeysRef.current.add(key);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      flyKeysRef.current.delete(event.key.toLowerCase());
    };
    const onMouseMove = (event: MouseEvent) => {
      const viewer = viewerRef.current;
      if (!flyActiveRef.current || !viewer || viewer.isDestroyed?.()) {
        return;
      }
      viewer.camera.lookRight(-event.movementX * 0.0017);
      viewer.camera.lookUp(-event.movementY * 0.0017);
    };

    let previousTime = performance.now();
    const flyFrame = (time: number) => {
      const viewer = viewerRef.current;
      const elapsedSeconds = Math.min((time - previousTime) / 1000, 0.1);
      previousTime = time;
      if (flyActiveRef.current && viewer && !viewer.isDestroyed?.()) {
        const keys = flyKeysRef.current;
        const speed = keys.has("shift") ? 34 : 8.5;
        const distance = speed * elapsedSeconds;
        if (keys.has("w")) viewer.camera.moveForward(distance);
        if (keys.has("s")) viewer.camera.moveBackward(distance);
        if (keys.has("a")) viewer.camera.moveLeft(distance);
        if (keys.has("d")) viewer.camera.moveRight(distance);
        if (keys.has("q")) viewer.camera.moveDown(distance);
        if (keys.has("e")) viewer.camera.moveUp(distance);
      }
      flyFrameRef.current = window.requestAnimationFrame(flyFrame);
    };

    document.addEventListener("pointerlockchange", onPointerLockChange);
    document.addEventListener("pointerlockerror", onPointerLockError);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("mousemove", onMouseMove);
    flyFrameRef.current = window.requestAnimationFrame(flyFrame);

    return () => {
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("pointerlockerror", onPointerLockError);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("mousemove", onMouseMove);
      if (flyFrameRef.current !== null) {
        window.cancelAnimationFrame(flyFrameRef.current);
      }
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
      setCesiumControls(true);
    };
  }, []);

  const selectBookmark = (nextBookmark: BookmarkId) => {
    applyBookmark(nextBookmark);
    updateUrlState(nextBookmark, currentQualityRef.current, selectedEpoch.id);
  };

  const selectQuality = (nextQuality: QualityId) => {
    applyQuality(nextQuality);
    updateUrlState(currentBookmarkRef.current, nextQuality, selectedEpoch.id);
  };

  const selectEpoch = (nextEpochId: string) => {
    if (!config.epochs.some((epoch) => epoch.id === nextEpochId)) {
      return;
    }
    setSelectedEpochId(nextEpochId);
    updateUrlState(
      currentBookmarkRef.current,
      currentQualityRef.current,
      nextEpochId
    );
  };

  const enterFlyMode = async () => {
    const canvas = viewerRef.current?.scene?.canvas as
      | HTMLCanvasElement
      | undefined;
    if (!canvas) {
      setRuntimeError("The 3D canvas is not ready for fly mode.");
      return;
    }
    try {
      canvas.focus();
      await canvas.requestPointerLock();
    } catch (error) {
      setRuntimeError(
        `Fly mode could not start: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  const resetMeasurement = () => {
    clearMeasurementEntities();
    setMeasurement(null);
    setMeasurementEnabled(false);
    setMeasurementHint(
      metricReady
        ? "Select Measure distance, then click two points on the metric mesh."
        : "Load an approved metric tileset to enable distance measurement."
    );
  };

  return (
    <main
      className="viewer-shell"
      data-testid={metricReady ? "viewer-ready" : undefined}
      data-shell-ready={shellReady ? "true" : "false"}
      data-map-epoch={selectedEpoch.id}
      data-release-id={selectedEpoch.releaseId}
      data-model-status={modelStatus}
    >
      <Script
        src={config.cesiumScriptUrl}
        strategy="afterInteractive"
        onReady={() => setEngineStatus("ready")}
        onError={() => {
          setEngineStatus("error");
          setRuntimeError(
            "CesiumJS failed to load. Check the configured script URL and network policy."
          );
        }}
      />

      <div
        ref={containerRef}
        className="cesium-stage"
        aria-label="Interactive 3D cemetery viewer"
      />
      <div className="stage-vignette" aria-hidden="true" />

      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            SM
          </span>
          <div>
            <p className="eyebrow">Public 3D record</p>
            <h1>Saint Martins Cemetery</h1>
          </div>
        </div>
        <div className="warning-chip" role="note">
          <span aria-hidden="true">△</span>
          GPS-scaled photogrammetry — not survey grade
        </div>
      </header>

      <nav className="timeline-panel panel" aria-label="Map timeline">
        <div className="timeline-heading">
          <span>
            <span className="eyebrow">Temporal record</span>
            <strong>Map epoch</strong>
          </span>
          <span className="timeline-count">{config.epochs.length}</span>
        </div>
        <ol className="epoch-list">
          {config.epochs.map((epoch) => {
            const epochGateOpen =
              epoch.publicReleaseApproved && epoch.privacyCropVerified;
            const selected = epoch.id === selectedEpoch.id;
            return (
              <li key={epoch.id}>
                <button
                  type="button"
                  className={selected ? "active" : ""}
                  aria-current={selected ? "date" : undefined}
                  aria-pressed={selected}
                  aria-label={`${epoch.captureDate}, ${epoch.label}, ${
                    epochGateOpen ? "published" : "held"
                  }`}
                  data-testid={`epoch-${epoch.id}`}
                  onClick={() => selectEpoch(epoch.id)}
                >
                  <time dateTime={epoch.captureDate}>{epoch.captureDate}</time>
                  <span>{epoch.label}</span>
                  <small className={epochGateOpen ? "pass" : "hold"}>
                    {epochGateOpen ? "Published" : "Held"}
                  </small>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="sr-only" aria-live="polite">
          Selected map epoch {selectedEpoch.captureDate}, {selectedEpoch.label}.
          Metric release {releaseGateOpen ? "permitted" : "held"}.
        </p>
      </nav>

      <aside className="status-panel panel" aria-label="Model and release status">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Release state</p>
            <h2>Model status</h2>
          </div>
          <span className={`status-dot status-${modelStatus}`} aria-hidden="true" />
        </div>

        <dl className="status-list">
          <div>
            <dt>Cesium engine</dt>
            <dd>{statusLabel(engineStatus)}</dd>
          </div>
          <div>
            <dt>OSM boundary</dt>
            <dd>{statusLabel(boundaryStatus)}</dd>
          </div>
          <div>
            <dt>Metric model</dt>
            <dd>{statusLabel(modelStatus)}</dd>
          </div>
          <div>
            <dt>Release ID</dt>
            <dd className="mono">{selectedEpoch.releaseId}</dd>
          </div>
          <div>
            <dt>Capture</dt>
            <dd>{selectedEpoch.captureDate}</dd>
          </div>
        </dl>

        <p className="status-detail">{modelDetail}</p>
        <div className="gate-row">
          <span className={selectedEpoch.publicReleaseApproved ? "pass" : "hold"}>
            Release {selectedEpoch.publicReleaseApproved ? "approved" : "held"}
          </span>
          <span className={selectedEpoch.privacyCropVerified ? "pass" : "hold"}>
            Crop {selectedEpoch.privacyCropVerified ? "verified" : "unverified"}
          </span>
        </div>
      </aside>

      <section className="camera-panel panel" aria-label="Camera presets">
        <div className="panel-heading compact">
          <div>
            <p className="eyebrow">Deterministic views</p>
            <h2>Camera</h2>
          </div>
          <select
            className="quality-select"
            aria-label="Rendering quality"
            value={quality}
            onChange={(event) => selectQuality(event.target.value as QualityId)}
          >
            {Object.entries(QUALITY_SETTINGS).map(([id, settings]) => (
              <option key={id} value={id}>
                {settings.label}
              </option>
            ))}
          </select>
        </div>
        <div className="preset-grid">
          {CAMERA_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={bookmark === preset.id ? "active" : ""}
              data-testid={`preset-${preset.id}`}
              onClick={() => selectBookmark(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`fly-button ${flyActive ? "active" : ""}`}
          onClick={() => {
            if (flyActive) {
              document.exitPointerLock();
            } else {
              void enterFlyMode();
            }
          }}
          disabled={!shellReady}
        >
          {flyActive ? "Exit fly mode" : "Enter fly mode"}
        </button>
        <p className="control-help">
          WASD move · Q/E descend/ascend · mouse look · Shift sprint · Esc release
        </p>
      </section>

      <section className="measure-panel panel" aria-label="Metric measurement">
        <div className="panel-heading compact">
          <div>
            <p className="eyebrow">Mesh authority</p>
            <h2>Distance</h2>
          </div>
          <span className={metricReady ? "authority-on" : "authority-off"}>
            {metricReady ? "Metric mesh" : "Disabled"}
          </span>
        </div>
        <p className="measure-hint" aria-live="polite">
          {measurementHint}
        </p>
        {measurement ? (
          <div className="measurement-result">
            <strong>{measurement.distance.toFixed(3)} m</strong>
            <span>
              A {measurement.pointA.longitude.toFixed(7)},{" "}
              {measurement.pointA.latitude.toFixed(7)} · h{" "}
              {measurement.pointA.height.toFixed(2)} m
            </span>
            <span>
              B {measurement.pointB.longitude.toFixed(7)},{" "}
              {measurement.pointB.latitude.toFixed(7)} · h{" "}
              {measurement.pointB.height.toFixed(2)} m
            </span>
          </div>
        ) : null}
        <div className="measure-actions">
          <button
            type="button"
            className={measurementEnabled ? "active" : ""}
            disabled={!metricReady}
            onClick={() => setMeasurementEnabled((enabled) => !enabled)}
          >
            {measurementEnabled ? "Stop measuring" : "Measure distance"}
          </button>
          <button type="button" onClick={resetMeasurement}>
            Clear
          </button>
        </div>
      </section>

      <details className="next-flight-panel panel">
        <summary>
          <span className="next-flight-title">
            <span className="eyebrow">Measured capture prescription</span>
            <strong>Next flight</strong>
          </span>
          <span className="next-flight-summary">
            Autel EVO II Pro Enterprise V3 RTK
          </span>
        </summary>
        <div className="next-flight-body">
          <section aria-labelledby="camera-lock-heading">
            <h3 id="camera-lock-heading">Camera lock</h3>
            <ul className="flight-checks">
              <li>
                ND filters <strong>off by default</strong>; no digital zoom, HDR,
                or AEB.
              </li>
              <li>
                Full <strong>5472 × 3648</strong>, 3:2, wide camera.
                Use JPG for the 2 s cadence; DNG needs at least 5 s or a
                settled capture.
              </li>
              <li>
                Manual <strong>1/1000 s target</strong>; 1/800 s moving-flight
                floor.
              </li>
              <li>
                Prefer f/4; open to f/2.8 before allowing a slower shutter.
              </li>
              <li>ISO 100–800; lock white balance and focus.</li>
            </ul>
          </section>

          <section aria-labelledby="control-heading">
            <h3 id="control-heading">Metric control</h3>
            <p>
              Require RTK <strong>FIX</strong> before production routes. Preserve
              raw satellite observations and flight logs; record the
              base/NTRIP correction source, datum, and firmware; measure
              independent checkpoints.
            </p>
          </section>

          <section aria-labelledby="mission-heading">
            <h3 id="mission-heading">Passes</h3>
            <div className="flight-table-wrap">
              <table className="flight-table">
                <caption className="sr-only">
                  Planned heights, gimbal angles, overlap, speed, and view
                  diversity
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Pass</th>
                    <th scope="col">Geometry</th>
                    <th scope="col">Cadence</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Global block</th>
                    <td>
                      30 m AGL · −90° nadir + four −45° to −50° oblique
                      headings · 83/80 overlap
                    </td>
                    <td>1.5 m/s · 2 s</td>
                  </tr>
                  <tr>
                    <th scope="row">Upright detail</th>
                    <td>
                      10 m AGL · −25° · N/S/E/W · ≤5 m line spacing
                    </td>
                    <td>1 m/s · 2 s</td>
                  </tr>
                  <tr>
                    <th scope="row">Facades</th>
                    <td>
                      8–15 m stand-off · −10° to −25° · five azimuth offsets
                    </td>
                    <td>1–2 m stations · ≤0.5 m/s or settled hover</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="azimuth-note">
              Facade azimuth offsets: −60°, −30°, 0°, +30°, +60°.
            </p>
          </section>

          <p className="flight-safety-note">
            Execute only with site authorization and a walked obstacle check;
            increase altitude for actual obstacles.
          </p>
        </div>
      </details>

      <aside className="disclosure-panel panel" aria-label="Accuracy and privacy">
        <p className="eyebrow">Read before use</p>
        <h2>Accuracy &amp; privacy</h2>
        <p>
          This is GPS-scaled photogrammetry, not a boundary or land survey. Do
          not use it for legal, engineering, excavation, or navigation decisions.
          {" "}Absolute accuracy: unvalidated.
        </p>
        <p>
          Camera metadata reports median stated GNSS accuracies of 0.847 m
          horizontal and 2.597 m vertical. Those metadata values are not
          demonstrated reconstruction accuracy.
        </p>
        <p>
          The selected triangulation reconstruction&apos;s measured average
          GNSS-prior residual was 3.125 m. It also does not establish survey
          accuracy.
        </p>
        <p>
          Public mesh loading is fail-closed until a physical privacy crop and
          release approval are verified. Browser clipping is not a privacy
          control.
        </p>
        {metricPermitted ? (
          <p>
            This epoch is a physically cropped public derivative; source
            photographs and camera metadata are not published. Inscriptions
            are not OCR-indexed or made searchable by this viewer.
          </p>
        ) : null}
        <p>
          The green outline is an OpenStreetMap screening proxy, not proof of a
          legal parcel boundary, ownership, access, authorization, or
          publication rights.
        </p>
        <div className="attribution">
          {metricConfigured ? (
            <span>
              3D model © 2026 {selectedEpoch.contentAttribution} ·{" "}
              <a
                href={selectedEpoch.contentLicenseUrl}
                rel="license noreferrer"
                target="_blank"
              >
                {selectedEpoch.contentLicense}
              </a>
              <br />
            </span>
          ) : null}
          Boundary © OpenStreetMap contributors · ODbL 1.0 ·{" "}
          <a href="/third-party-notices.txt">Third-party notices</a>
        </div>
      </aside>

      <footer className="coordinate-bar">
        <div>
          <span className="coordinate-label">Navigation position · WGS84</span>
          {cameraReadout ? (
            <span className="mono">
              {cameraReadout.longitude.toFixed(7)}°,{" "}
              {cameraReadout.latitude.toFixed(7)}° · ellipsoid h{" "}
              {cameraReadout.height.toFixed(2)} m
            </span>
          ) : (
            <span>Waiting for camera…</span>
          )}
        </div>
        <div>
          <span className="coordinate-label">ECEF Cartesian · metres</span>
          {cameraReadout ? (
            <span className="mono">
              X {cameraReadout.x.toFixed(2)} · Y {cameraReadout.y.toFixed(2)} · Z{" "}
              {cameraReadout.z.toFixed(2)}
            </span>
          ) : (
            <span>—</span>
          )}
        </div>
      </footer>

      {engineStatus === "loading" || boundaryStatus === "loading" ? (
        <div className="loading-card" role="status" aria-live="polite">
          <span className="loader" aria-hidden="true" />
          <div>
            <strong>Preparing public scene</strong>
            <span>
              {engineStatus === "loading"
                ? "Loading licensed CesiumJS runtime…"
                : "Loading the OSM boundary overlay…"}
            </span>
          </div>
        </div>
      ) : null}

      {runtimeError ? (
        <div className="error-card" role="alert">
          <div>
            <strong>Viewer asset error</strong>
            <span>{runtimeError}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setRuntimeError("");
              setReloadToken((token) => token + 1);
            }}
          >
            Retry assets
          </button>
        </div>
      ) : null}

      {!metricReady ? (
        <div className="release-banner" role="status">
          <span className="lock-icon" aria-hidden="true">
            ◇
          </span>
          <span>{releaseGateMessage}</span>
        </div>
      ) : null}
    </main>
  );
}
