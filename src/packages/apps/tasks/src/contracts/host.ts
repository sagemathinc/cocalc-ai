export interface TasksKeyboardServices {
  enableKeyHandler(): void;
  disableKeyHandler(): void;
}

export interface TasksDocumentCommandServices {
  save(): void;
  undo(): void;
  redo(): void;
}

export interface TasksNavigationServices {
  navigateToFragment?(fragment: string): void;
}

export interface TasksHostServices
  extends
    TasksKeyboardServices,
    TasksDocumentCommandServices,
    TasksNavigationServices {}
