export interface DisposableBrowserController {
  dispose(): void;
}
/** Keeps a browser controller tied to the lifetime of its BrowserWindow. */
export class BrowserControllerLifecycle<Window, Controller extends DisposableBrowserController> {
  private currentWindow: Window | undefined;
  private currentController: Controller | undefined;

  constructor(private readonly createController: (window: Window) => Controller) {}

  get controller(): Controller | undefined {
    return this.currentController;
  }

  attach(window: Window): Controller {
    if (this.currentWindow === window && this.currentController) {
      return this.currentController;
    }
    this.reset();
    this.currentWindow = window;
    this.currentController = this.createController(window);
    return this.currentController;
  }

  onClosed(window: Window): void {
    if (this.currentWindow !== window) {
      return;
    }
    this.reset();
  }

  reset(): void {
    this.currentController?.dispose();
    this.currentController = undefined;
    this.currentWindow = undefined;
  }
}
