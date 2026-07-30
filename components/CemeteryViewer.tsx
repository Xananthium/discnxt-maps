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
type NavigationMode = "walk" | "fly";

interface CameraPreset {
  id: BookmarkId;
  label: string;
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  range: number;
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
    longitude: -80.0383930968,
    latitude: 40.4481286031,
    height: 298,
    heading: 0,
    pitch: -90,
    range: 240
  },
  {
    id: "north-oblique",
    label: "North oblique",
    longitude: -80.0383930968,
    latitude: 40.4481286031,
    height: 298,
    heading: 0,
    pitch: -18,
    range: 180
  },
  {
    id: "south-oblique",
    label: "South oblique",
    longitude: -80.0383930968,
    latitude: 40.4481286031,
    height: 298,
    heading: 180,
    pitch: -18,
    range: 180
  },
  {
    id: "east-edge",
    label: "East edge",
    longitude: -80.0383930968,
    latitude: 40.4481286031,
    height: 298,
    heading: 90,
    pitch: -18,
    range: 180
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
const SELECTION_ENTITY_ID = "metric-coordinate-selection";
const WALK_EYE_HEIGHT_M = 1.7;

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

function pickMetricPosition(
  viewer: any,
  Cesium: any,
  tileset: any,
  windowPosition: any
): any | null {
  const ray = viewer.camera.getPickRay(windowPosition);
  const picked = ray ? viewer.scene.drillPickFromRay(ray, 20) : [];
  const metricHit = picked.find((candidate: any) =>
    belongsToTileset(candidate.object, tileset)
  );
  return metricHit && Cesium.defined(metricHit.position)
    ? metricHit.position
    : null;
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
  const selectionHandlerRef = useRef<any>(null);
  const measurementPointsRef = useRef<any[]>([]);
  const selectedPointRef = useRef<any>(null);
  const flyKeysRef = useRef<Set<string>>(new Set());
  const flyFrameRef = useRef<number | null>(null);
  const flyActiveRef = useRef(false);
  const walkLandingRef = useRef(false);
  const navigationModeRef = useRef<NavigationMode>("walk");
  const orbitHeadingRef = useRef(0);
  const currentBookmarkRef = useRef<BookmarkId>("north-oblique");
  const currentQualityRef = useRef<QualityId>("balanced");

  const [engineStatus, setEngineStatus] = useState<AssetPhase>("loading");
  const [boundaryStatus, setBoundaryStatus] = useState<AssetPhase>("idle");
  const [modelStatus, setModelStatus] = useState<AssetPhase>("idle");
  const [modelDetail, setModelDetail] = useState(defaultEpoch.modelStatusLabel);
  const [runtimeError, setRuntimeError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [bookmark, setBookmark] = useState<BookmarkId>("north-oblique");
  const [quality, setQuality] = useState<QualityId>("balanced");
  const [selectedEpochId, setSelectedEpochId] = useState(defaultEpoch.id);
  const [urlStateResolved, setUrlStateResolved] = useState(false);
  const [flyActive, setFlyActive] = useState(false);
  const [navigationMode, setNavigationMode] =
    useState<NavigationMode>("walk");
  const [pickEnabled, setPickEnabled] = useState(false);
  const [selectionHint, setSelectionHint] = useState(
    "Pick a mesh point for coordinates, local orbit, or ground entry."
  );
  const [selectedPoint, setSelectedPoint] = useState<CameraReadout | null>(null);
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

  const clearSelection = useCallback(() => {
    const viewer = viewerRef.current;
    if (viewer && !viewer.isDestroyed?.()) {
      viewer.entities.removeById(SELECTION_ENTITY_ID);
    }
    selectedPointRef.current = null;
    setSelectedPoint(null);
    setPickEnabled(false);
    setSelectionHint(
      "Pick a mesh point for coordinates, local orbit, or ground entry."
    );
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
      : "north-oblique";
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
    const target =
      tilesetRef.current?.boundingSphere?.center ??
      Cesium.Cartesian3.fromDegrees(
        preset.longitude,
        preset.latitude,
        preset.height
      );
    viewer.camera.lookAt(
      target,
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(preset.heading),
        Cesium.Math.toRadians(preset.pitch),
        preset.range
      )
    );
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    viewer.scene.requestRender?.();
  }, []);

  const destroyViewer = useCallback(() => {
    measurementHandlerRef.current?.destroy?.();
    measurementHandlerRef.current = null;
    selectionHandlerRef.current?.destroy?.();
    selectionHandlerRef.current = null;
    tilesetRef.current = null;
    measurementPointsRef.current = [];
    selectedPointRef.current = null;
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
    setPickEnabled(false);
    setSelectedPoint(null);
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
      viewer.scene.screenSpaceCameraController.minimumZoomDistance =
        WALK_EYE_HEIGHT_M;
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
    selectionHandlerRef.current?.destroy?.();
    selectionHandlerRef.current = null;
    clearMeasurementEntities();
    clearSelection();
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
              enableCollision: true,
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
          applyBookmark(currentBookmarkRef.current);
          setModelStatus("streaming");
          setModelDetail(
            `Epoch ${selectedEpoch.id} metadata loaded; waiting for its first visible metric tile.`
          );
          removeTileVisibleListener = tileset.tileVisible.addEventListener(() => {
            if (!disposed && tilesetRef.current === tileset) {
              setModelStatus("ready");
              setModelDetail(
                `Epoch ${selectedEpoch.id} is visible. Mesh picking, distance, and collision navigation are enabled.`
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
    applyBookmark,
    clearMeasurementEntities,
    clearSelection,
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
      const point = pickMetricPosition(
        viewer,
        Cesium,
        tileset,
        movement.position
      );
      if (!point) {
        setMeasurementHint(
          "That point is not on the approved metric tileset. Choose the visible mesh."
        );
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
    selectionHandlerRef.current?.destroy?.();
    selectionHandlerRef.current = null;

    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    const tileset = tilesetRef.current;
    if (
      !pickEnabled ||
      !metricReady ||
      !viewer ||
      !Cesium ||
      !tileset ||
      viewer.isDestroyed?.()
    ) {
      return;
    }

    setSelectionHint("Click one point on the visible metric mesh.");
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    selectionHandlerRef.current = handler;
    handler.setInputAction((movement: any) => {
      const point = pickMetricPosition(
        viewer,
        Cesium,
        tileset,
        movement.position
      );
      if (!point) {
        setSelectionHint("That click missed the metric mesh. Try a visible surface.");
        return;
      }

      viewer.entities.removeById(SELECTION_ENTITY_ID);
      viewer.entities.add({
        id: SELECTION_ENTITY_ID,
        position: point,
        point: {
          color: Cesium.Color.fromCssColorString("#5ef2ad"),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          pixelSize: 12,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      selectedPointRef.current = Cesium.Cartesian3.clone(point);
      orbitHeadingRef.current = viewer.camera.heading;
      setSelectedPoint(toReadout(Cesium, point));
      setSelectionHint(
        "Point fixed in ECEF. Orbit it, enter at ground level, or copy its coordinates."
      );
      setPickEnabled(false);
      viewer.scene.requestRender?.();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    return () => {
      if (selectionHandlerRef.current === handler) {
        handler.destroy();
        selectionHandlerRef.current = null;
      }
    };
  }, [metricReady, pickEnabled, reloadToken]);

  useEffect(() => {
    if (engineStatus !== "ready" || !window.Cesium) {
      return;
    }

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
      if (key === "f" && !event.repeat) {
        event.preventDefault();
        const nextMode =
          navigationModeRef.current === "walk" ? "fly" : "walk";
        navigationModeRef.current = nextMode;
        walkLandingRef.current = nextMode === "walk";
        setNavigationMode(nextMode);
        return;
      }
      if (
        ["w", "a", "s", "d", "q", "e", "shift", " ", "control"].includes(
          key
        )
      ) {
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

    const Cesium = window.Cesium;
    const scratchUp = Cesium ? new Cesium.Cartesian3() : null;
    const scratchForward = Cesium ? new Cesium.Cartesian3() : null;
    const scratchRight = Cesium ? new Cesium.Cartesian3() : null;
    const scratchScaled = Cesium ? new Cesium.Cartesian3() : null;
    const scratchOrigin = Cesium ? new Cesium.Cartesian3() : null;
    const scratchDown = Cesium ? new Cesium.Cartesian3() : null;
    const scratchEye = Cesium ? new Cesium.Cartesian3() : null;

    const snapWalkToMesh = (viewer: any, force = false) => {
      const tileset = tilesetRef.current;
      if (!Cesium || !tileset || !scratchUp) {
        return;
      }
      const camera = viewer.camera;
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
        camera.positionWC,
        scratchUp
      );
      Cesium.Cartesian3.multiplyByScalar(scratchUp, 10, scratchScaled);
      Cesium.Cartesian3.add(camera.positionWC, scratchScaled, scratchOrigin);
      Cesium.Cartesian3.negate(scratchUp, scratchDown);
      const hits = viewer.scene.drillPickFromRay(
        new Cesium.Ray(scratchOrigin, scratchDown),
        20
      );
      const ground = hits.find(
        (candidate: any) =>
          belongsToTileset(candidate.object, tileset) &&
          Cesium.defined(candidate.position)
      );
      if (!ground) {
        return;
      }
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
        ground.position,
        scratchUp
      );
      Cesium.Cartesian3.multiplyByScalar(
        scratchUp,
        WALK_EYE_HEIGHT_M,
        scratchScaled
      );
      Cesium.Cartesian3.add(ground.position, scratchScaled, scratchEye);
      if (
        force ||
        Cesium.Cartesian3.distance(camera.positionWC, scratchEye) <= 3
      ) {
        Cesium.Cartesian3.clone(scratchEye, camera.position);
      }
    };

    let previousTime = performance.now();
    const flyFrame = (time: number) => {
      const viewer = viewerRef.current;
      const elapsedSeconds = Math.min((time - previousTime) / 1000, 0.1);
      previousTime = time;
      if (
        flyActiveRef.current &&
        viewer &&
        Cesium &&
        scratchUp &&
        !viewer.isDestroyed?.()
      ) {
        const keys = flyKeysRef.current;
        const walking = navigationModeRef.current === "walk";
        const speed = walking
          ? keys.has("shift")
            ? 5.5
            : 2.2
          : keys.has("shift")
            ? 28
            : 8;
        const distance = speed * elapsedSeconds;
        let moved = false;

        if (walking) {
          const camera = viewer.camera;
          if (walkLandingRef.current) {
            snapWalkToMesh(viewer, true);
            walkLandingRef.current = false;
          }
          Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
            camera.positionWC,
            scratchUp
          );
          const vertical = Cesium.Cartesian3.dot(
            camera.directionWC,
            scratchUp
          );
          Cesium.Cartesian3.multiplyByScalar(
            scratchUp,
            vertical,
            scratchScaled
          );
          Cesium.Cartesian3.subtract(
            camera.directionWC,
            scratchScaled,
            scratchForward
          );
          if (Cesium.Cartesian3.magnitudeSquared(scratchForward) > 1e-8) {
            Cesium.Cartesian3.normalize(scratchForward, scratchForward);
            Cesium.Cartesian3.cross(
              scratchForward,
              scratchUp,
              scratchRight
            );
            Cesium.Cartesian3.normalize(scratchRight, scratchRight);
            if (keys.has("w")) {
              camera.move(scratchForward, distance);
              moved = true;
            }
            if (keys.has("s")) {
              camera.move(scratchForward, -distance);
              moved = true;
            }
            if (keys.has("a")) {
              camera.move(scratchRight, -distance);
              moved = true;
            }
            if (keys.has("d")) {
              camera.move(scratchRight, distance);
              moved = true;
            }
          }
          if (moved) {
            snapWalkToMesh(viewer);
          }
        } else {
          Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
            viewer.camera.positionWC,
            scratchUp
          );
          if (keys.has("w")) viewer.camera.moveForward(distance);
          if (keys.has("s")) viewer.camera.moveBackward(distance);
          if (keys.has("a")) viewer.camera.moveLeft(distance);
          if (keys.has("d")) viewer.camera.moveRight(distance);
          if (keys.has("q") || keys.has("control")) {
            viewer.camera.move(scratchUp, -distance);
          }
          if (keys.has("e") || keys.has(" ")) {
            viewer.camera.move(scratchUp, distance);
          }
        }
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
  }, [engineStatus]);

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

  const orbitSelected = (deltaDegrees: number) => {
    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    const anchor = selectedPointRef.current;
    if (!viewer || !Cesium || !anchor || viewer.isDestroyed?.()) {
      setSelectionHint("Pick a metric-mesh point before using local-up orbit.");
      return;
    }
    const transform = Cesium.Transforms.eastNorthUpToFixedFrame(anchor);
    const range = Math.min(
      450,
      Math.max(8, Cesium.Cartesian3.distance(viewer.camera.positionWC, anchor))
    );
    orbitHeadingRef.current += Cesium.Math.toRadians(deltaDegrees);
    viewer.camera.lookAtTransform(
      transform,
      new Cesium.HeadingPitchRange(
        orbitHeadingRef.current,
        Cesium.Math.toRadians(-32),
        range
      )
    );
    viewer.scene.requestRender?.();
  };

  const enterWorld = async () => {
    const viewer = viewerRef.current;
    const Cesium = window.Cesium;
    const anchor = selectedPointRef.current;
    const canvas = viewer?.scene?.canvas as
      | HTMLCanvasElement
      | undefined;
    if (!viewer || !Cesium || !canvas || !anchor) {
      setPickEnabled(true);
      setMeasurementEnabled(false);
      setSelectionHint(
        "Pick a clear ground point first; Enter world will place the camera 1.7 m above it."
      );
      return;
    }
    try {
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
        anchor,
        new Cesium.Cartesian3()
      );
      const eye = Cesium.Cartesian3.add(
        anchor,
        Cesium.Cartesian3.multiplyByScalar(
          up,
          WALK_EYE_HEIGHT_M,
          new Cesium.Cartesian3()
        ),
        new Cesium.Cartesian3()
      );
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(anchor);
      const north = Cesium.Matrix4.multiplyByPointAsVector(
        enu,
        Cesium.Cartesian3.UNIT_Y,
        new Cesium.Cartesian3()
      );
      Cesium.Cartesian3.normalize(north, north);
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      viewer.camera.setView({
        destination: eye,
        orientation: { direction: north, up }
      });
      navigationModeRef.current = "walk";
      setNavigationMode("walk");
      canvas.focus();
      await canvas.requestPointerLock();
    } catch (error) {
      setRuntimeError(
        `World mode could not start: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  const copySelectedCoordinates = async () => {
    if (!selectedPoint) {
      return;
    }
    const value = [
      `WGS84 ${selectedPoint.latitude.toFixed(8)}, ${selectedPoint.longitude.toFixed(8)}`,
      `ellipsoid_h_m ${selectedPoint.height.toFixed(3)}`,
      `ECEF_m ${selectedPoint.x.toFixed(3)}, ${selectedPoint.y.toFixed(3)}, ${selectedPoint.z.toFixed(3)}`,
      `epoch ${selectedEpoch.id}`
    ].join("\n");
    try {
      await navigator.clipboard.writeText(value);
      setSelectionHint("WGS84 and ECEF coordinates copied.");
    } catch {
      setSelectionHint("Clipboard access was denied; coordinates remain visible below.");
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
      className={`viewer-shell${flyActive ? " world-active" : ""}`}
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
            <h1>Saint Martins Cemetery</h1>
          </div>
        </div>
        <div className="lab-chip" role="status">
          <span className={`status-dot status-${modelStatus}`} aria-hidden="true" />
          LAB · {selectedEpoch.captureDate}
        </div>
      </header>

      {config.epochs.length > 1 ? (
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
      ) : null}

      <p className="sr-only" aria-live="polite">
        Cesium {statusLabel(engineStatus)}. Boundary {statusLabel(boundaryStatus)}.
        Model {statusLabel(modelStatus)}. {modelDetail}
      </p>

      <details className="camera-panel panel control-drawer">
        <summary className="drawer-summary">View</summary>
        <div className="drawer-body" aria-label="Camera presets">
          <div className="panel-heading compact">
          <div>
            <p className="eyebrow">Cesium camera</p>
            <h2>Navigate</h2>
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
          <div className="orbit-grid">
          <button
            type="button"
            disabled={!selectedPoint}
            onClick={() => orbitSelected(-15)}
          >
            ↶ Local up
          </button>
          <button
            type="button"
            disabled={!selectedPoint}
            onClick={() => orbitSelected(15)}
          >
            Local up ↷
          </button>
          </div>
          <button
          type="button"
          className={`fly-button ${flyActive ? "active" : ""}`}
          onClick={() => {
            if (flyActive) {
              document.exitPointerLock();
            } else {
              void enterWorld();
            }
          }}
          disabled={!metricReady}
        >
          {flyActive
            ? `Exit ${navigationMode} mode`
            : selectedPoint
              ? "Enter world"
              : "Pick ground to enter"}
          </button>
          <p className="control-help">
            WASD · mouse · Shift · F walk/fly
            {navigationMode === "fly" ? " · Space/Q up/down" : ""} · Esc
          </p>
        </div>
      </details>

      <details className="measure-panel panel control-drawer">
        <summary className="drawer-summary">Point / measure</summary>
        <div className="drawer-body" aria-label="Spatial tools">
          <div className="panel-heading compact">
          <div>
            <p className="eyebrow">Metric mesh</p>
            <h2>Point &amp; distance</h2>
          </div>
          <span className={metricReady ? "authority-on" : "authority-off"}>
            {metricReady ? "Ready" : "Disabled"}
          </span>
          </div>
          <p className="measure-hint" aria-live="polite">
          {measurementEnabled ? measurementHint : selectionHint}
          </p>
          {selectedPoint ? (
          <div className="selection-result">
            <span>
              WGS84 lon {selectedPoint.longitude.toFixed(7)} · lat{" "}
              {selectedPoint.latitude.toFixed(7)}
            </span>
            <small>ellipsoid h {selectedPoint.height.toFixed(2)} m</small>
            <small>
              ECEF X {selectedPoint.x.toFixed(2)} · Y {selectedPoint.y.toFixed(2)}
              {" · "}Z {selectedPoint.z.toFixed(2)} m
            </small>
            <button type="button" onClick={() => void copySelectedCoordinates()}>
              Copy WGS84 + ECEF
            </button>
          </div>
          ) : null}
          {measurement ? (
          <div className="measurement-result">
            <strong>{measurement.distance.toFixed(3)} m</strong>
            <span>3D straight ECEF distance</span>
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
          <div className="measure-actions tool-actions">
          <button
            type="button"
            className={pickEnabled ? "active" : ""}
            disabled={!metricReady}
            onClick={() => {
              setMeasurementEnabled(false);
              setPickEnabled((enabled) => !enabled);
            }}
          >
            {pickEnabled ? "Cancel pick" : "Pick point"}
          </button>
          <button
            type="button"
            className={measurementEnabled ? "active" : ""}
            disabled={!metricReady}
            onClick={() => {
              setPickEnabled(false);
              setMeasurementEnabled((enabled) => !enabled);
            }}
          >
            {measurementEnabled ? "Cancel measure" : "Measure"}
          </button>
          <button
            type="button"
            onClick={() => {
              resetMeasurement();
              clearSelection();
            }}
          >
            Clear
          </button>
          </div>
        </div>
      </details>

      <details className="next-flight-panel panel">
        <summary>
          <span className="next-flight-title">
            <strong>Flight</strong>
          </span>
        </summary>
        <div className="next-flight-body">
          <p className="flight-aircraft">
            Autel EVO II Pro Enterprise V3 RTK
          </p>
          <section aria-labelledby="camera-lock-heading">
            <h3 id="camera-lock-heading">Camera lock</h3>
            <ul className="flight-checks">
              <li>
                ND8/ND16 filters <strong>off</strong> unless full sun still
                overexposes at ISO 100, f/4, and the required fast shutter; no
                digital zoom, HDR, or AEB.
              </li>
              <li>
                Full <strong>5472 × 3648</strong>, 3:2, wide camera.
                Use JPG for the 2 s route cadence; reserve DNG/JPG+DNG for
                settled detail captures if the controller cannot sustain that
                interval.
              </li>
              <li>
                Manual <strong>1/1000 s target</strong>; 1/800 s moving-flight
                floor.
              </li>
              <li>
                Prefer f/4; open to f/2.8 before allowing a slower shutter.
              </li>
              <li>
                Start ISO 100, cap at 400 (800 only to protect shutter); lock
                white balance and focus after a test frame.
              </li>
            </ul>
          </section>

          <section aria-labelledby="control-heading">
            <h3 id="control-heading">Metric control</h3>
            <p>
              Require RTK <strong>FIX</strong> before production routes. Preserve
              raw satellite observations and flight logs; record the
              base/NTRIP correction source, datum, and firmware; measure
              independent checkpoints. Altitudes are above takeoff, not canopy.
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
                      Highest canopy + terrain rise + 15 m. If verified canopy is
                      30 m and terrain is level: <strong>45 m / 148 ft</strong>
                      · −90° · 83/80 overlap
                    </td>
                    <td>3 m/s · 10.8 km/h max · 2 s</td>
                  </tr>
                  <tr>
                    <th scope="row">Oblique block</th>
                    <td>
                      Same verified safe altitude · −45° to −50° · opposing
                      cross-grid headings · 80/80 overlap
                    </td>
                    <td>2.5 m/s · 9 km/h · 2 s</td>
                  </tr>
                  <tr>
                    <th scope="row">Upright/facade</th>
                    <td>
                      Only walked, visually cleared corridors: 15–20 m above
                      local ground · 10–15 m stand-off · −15° to −35° · opposing
                      headings
                    </td>
                    <td>1 m/s · 3.6 km/h or 2–3 m settled stations</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="azimuth-note">
              Battery 1: proof strip + nadir. Batteries 2 and 3: perpendicular
              safe-altitude oblique grids. Recharge before cleared detail
              corridors or settled facade stations.
            </p>
          </section>

          <p className="flight-safety-note">
            Walk the site first. Treat sensing as last-resort braking, not a
            branch/wire route planner. Abort if RTK leaves FIX, exposure drifts,
            the aircraft brakes/holds, or the route loses clearance.
          </p>
        </div>
      </details>

      {flyActive ? (
        <>
          <span className="world-reticle" aria-hidden="true" />
          <div className="world-hud" role="status">
            {navigationMode.toUpperCase()} · F toggles · Esc releases
          </div>
        </>
      ) : null}

      <div className="scene-credit">
        {metricConfigured ? (
          <>
            © {selectedEpoch.contentAttribution} ·{" "}
            <a
              href={selectedEpoch.contentLicenseUrl}
              rel="license noreferrer"
              target="_blank"
            >
              {selectedEpoch.contentLicense}
            </a>
            {" · "}
          </>
        ) : null}
        <a href="/third-party-notices.txt">credits</a>
      </div>

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
