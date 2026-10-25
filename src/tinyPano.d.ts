export type ImageSource = string | Blob | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | ImageBitmap;
export interface MultiResLevel { width: number; height: number; url?: string; urlTemplate?: string; tileSize?: number; z?: string | number }
export interface MultiResTiles { tileSize?: number; levels: MultiResLevel[] }
export type ViewMode = 'normal' | 'tinyplanet' | 'tunnel' | 'fisheye';
export interface View { yaw: number; pitch: number; hfov: number; viewMode?: ViewMode }
export interface ViewState extends View { sceneId: string | null }
export interface ViewerStrings {
    zoomIn: string; zoomOut: string; fullscreen: string; loadPanorama: string; loading: string;
    contextLost: string; interactivePanorama: string; information: string; openScene: string;
    invalidSource: string; emptySource: string; imageLoadError: string; unsupportedType: string;
    cubemapFaces: string; renderError: string; unknownScene: string; fullscreenError: string;
    gyroscope: string; gyroscopeUnavailable: string; gyroscopePermission: string; invalidView: string;
    compass: string; north: string; east: string; south: string; west: string;
}
export interface LoadEvent { sceneId: string | null; requestId: number }
export interface RenderEvent extends LoadEvent { preview: boolean }
export interface PreloadEvent { sceneId: string; requestId: number; cached?: boolean }
export interface GyroscopeEvent { enabled: boolean }
export interface AutoRotateEvent { enabled: boolean; speed: number }
export interface ViewModeEvent { viewMode: ViewMode }
export interface LanguageEvent { language: 'en' | 'de' }
export interface ViewerError extends Error { code: string; sceneId: string | null; requestId: number }
export interface HotSpot {
    id?: string; pitch?: number; yaw?: number; text?: string; type?: 'info' | 'scene';
    URL?: string; sceneId?: string; targetPitch?: number; targetYaw?: number; targetHfov?: number;
    /** Draw this marker as a highlighted point of interest. */
    highlight?: boolean;
    clickHandlerFunc?: (event: MouseEvent, args?: unknown) => void; clickHandlerArgs?: unknown;
}
export interface Config {
    /** Camera display style, independent of the source image projection. Defaults to normal. */
    viewMode?: ViewMode;
    type?: 'equirectangular' | 'cubemap' | 'cylindrical' | 'rectilinear' | 'multires'; panorama?: ImageSource; cubeMap?: ImageSource[];
    /** Equirectangular tile pyramid. URL templates use {z}, {x}, and {y}; {x} and {y} are required. */
    tiles?: MultiResTiles; maxTileCache?: number;
    /** Parse Photo Sphere GPano fields from JPEG XMP on Blob/File sources (default true). */
    readXMP?: boolean;
    /** Optional low-resolution equirectangular image; also supported before a full cubemap. */
    preview?: ImageSource;
    /** en/de, regional tags such as de-AT, or auto (document/browser language, default). */
    language?: string; strings?: Partial<ViewerStrings>;
    yaw?: number; pitch?: number; hfov?: number; minHfov?: number; maxHfov?: number;
    /** Clockwise bearing of the image center from true north; null means unknown. */
    northOffset?: number | null; compass?: boolean;
    minYaw?: number; maxYaw?: number; minPitch?: number; maxPitch?: number;
    haov?: number; vaov?: number; hOffset?: number; vOffset?: number;
    /** Clockwise horizon tilt in degrees; GPano PoseRollDegrees is corrected automatically. */
    horizonCorrection?: number; backgroundColor?: [number, number, number];
    title?: string; author?: string; basePath?: string; crossOrigin?: 'anonymous' | 'use-credentials' | null;
    autoLoad?: boolean; autoRotate?: number; showControls?: boolean; showZoomCtrl?: boolean;
    showFullscreenCtrl?: boolean; showGyroscopeCtrl?: boolean; keyboardZoom?: boolean; mouseZoom?: boolean | 'fullscreenonly';
    /** Keep the pointed image feature fixed during wheel zoom (default true); gyro zoom stays centered. */
    zoomToCursor?: boolean;
    draggable?: boolean; disableKeyboardCtrl?: boolean; inertia?: boolean;
    renderer?: 'auto' | 'webgl' | 'canvas'; maxDpr?: number; maxPixels?: number;
    maxTextureSize?: number; fallbackWidth?: number;
    /** Number of decoded scenes retained by preloadScene; clamped to 0–8 (default 2). Zero disables preloading. */
    maxPreloadedScenes?: number;
    /** Approximate decoded RGBA cache budget in bytes (default 64 MiB). Zero disables preloading. */
    maxPreloadBytes?: number;
    hotSpots?: HotSpot[]; firstScene?: string; default?: Config; scenes?: Record<string, Config>;
}
export interface Stats {
    renderer: 'webgl' | 'canvas' | null; frames: number; width: number; height: number;
    active: boolean; loaded: boolean; loading: boolean; preview: boolean;
    textureWidth?: number; textureHeight?: number; downscaled?: boolean; tiled?: boolean; preloadedScenes: number;
    /** Estimated decoded bytes retained in the scene cache, excluding the active renderer. */
    preloadedBytes: number;
}
export interface Viewer {
    on(name: 'load' | 'destroy' | 'contextlost' | 'contextrestored', callback: () => void): this;
    on(name: 'loadstart' | 'previewload' | 'sceneload', callback: (event: LoadEvent) => void): this;
    on(name: 'preloadstart' | 'scenepreload', callback: (event: PreloadEvent) => void): this;
    on(name: 'preloaderror', callback: (error: ViewerError) => void): this;
    on(name: 'render', callback: (event: RenderEvent) => void): this;
    on(name: 'gyroscopechange', callback: (event: GyroscopeEvent) => void): this;
    on(name: 'autorotatechange', callback: (event: AutoRotateEvent) => void): this;
    on(name: 'viewmodechange', callback: (event: ViewModeEvent) => void): this;
    on(name: 'languagechange', callback: (event: LanguageEvent) => void): this;
    on(name: 'error', callback: (error: ViewerError) => void): this;
    on(name: 'viewchange', callback: (view: View) => void): this;
    on(name: 'scenechange', callback: (sceneId: string) => void): this;
    on(name: 'hotspotclick' | 'hotspotfocus', callback: (hotspot: HotSpot) => void): this;
    off(name: string, callback?: (...args: any[]) => void): this;
    load(): this; loadScene(id: string, pitch?: number, yaw?: number, hfov?: number): this;
    preloadScene(id: string): this; clearSceneCache(id?: string): this;
    addScene(id: string, scene: Config): this; removeScene(id: string): this;
    getScene(): string | null; getContainer(): HTMLElement;
    getViewState(): ViewState; setViewState(state: Partial<ViewState>, duration?: number): this;
    getViewURL(url?: string): string; loadViewURL(url?: string): this;
    getViewMode(): ViewMode;
    /** Switch display style and its starting view without loading the image again; normal restores the previous camera. */
    setViewMode(mode: ViewMode): this;
    getLanguage(): 'en' | 'de';
    /** Update viewer controls and built-in labels without reloading the image or resetting the view. */
    setLanguage(language: string, strings?: Partial<ViewerStrings>): this;
    lookAt(pitch?: number | null, yaw?: number | null, hfov?: number | null, duration?: number): this;
    setYaw(yaw: number, duration?: number): this; setPitch(pitch: number, duration?: number): this;
    /** Change zoom while retaining active or pending gyroscope control. */
    setHfov(hfov: number, duration?: number): this;
    zoomIn(step?: number, duration?: number): this; zoomOut(step?: number, duration?: number): this;
    getYaw(): number; getPitch(): number; getHfov(): number;
    getNorthOffset(): number | null; setNorthOffset(offset: number | null): this;
    getBearing(): number | null;
    isLoaded(): boolean; getRenderer(): 'webgl' | 'canvas' | null; getStats(): Stats;
    addHotSpot(hotspot: HotSpot, sceneId?: string): this; removeHotSpot(id: string, sceneId?: string): this;
    focusHotSpot(id: string, duration?: number): this;
    startAutoRotate(speed?: number): this; stopAutoRotate(): this; isAutoRotating(): boolean;
    startGyroscope(): this; stopGyroscope(): this; isGyroscopeEnabled(): boolean;
    mouseEventToCoords(event: Pick<MouseEvent, 'clientX' | 'clientY'>): [pitch: number, yaw: number];
    isFullscreen(): boolean; toggleFullscreen(): this; resize(): this; destroy(): void;
}
export function viewer(target: string | HTMLElement, options?: Config): Viewer;
export const version: string;
declare const tinyPano: { viewer: typeof viewer; version: string };
export default tinyPano;
