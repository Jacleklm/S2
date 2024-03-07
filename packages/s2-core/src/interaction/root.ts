import { concat, find, forEach, isBoolean, isEmpty, isNil, map } from 'lodash';
import type { MergedCell } from '../cell';
import {
  CellType,
  INTERACTION_STATE_INFO_KEY,
  InteractionName,
  InteractionStateName,
  InterceptType,
  S2Event,
} from '../common/constant';
import type {
  BrushSelectionInfo,
  BrushSelectionOptions,
  CellMeta,
  ChangeCellOptions,
  CustomInteraction,
  InteractionCellHighlightOptions,
  InteractionStateInfo,
  Intercept,
  MergedCellInfo,
  ScrollOffsetConfig,
  S2CellType,
  ViewMeta,
} from '../common/interface';
import type { Node } from '../facet/layout/node';
import type { SpreadSheet } from '../sheet-type';
import { hideColumnsByThunkGroup } from '../utils/hide-columns';
import { mergeCell, unmergeCell } from '../utils/interaction/merge-cell';
import { getCellMeta } from '../utils/interaction/select-event';
import { clearState, setState } from '../utils/interaction/state-controller';
import { isMobile } from '../utils/is-mobile';
import { customMerge } from '../utils';
import type { BaseEvent } from './base-event';
import {
  DataCellClick,
  MergedCellClick,
  RowColumnClick,
  RowTextClick,
} from './base-interaction/click';
import { CornerCellClick } from './base-interaction/click/corner-cell-click';
import { HoverEvent } from './base-interaction/hover';
import { ColCellBrushSelection } from './brush-selection/col-brush-selection';
import { DataCellBrushSelection } from './brush-selection/data-cell-brush-selection';
import { RowCellBrushSelection } from './brush-selection/row-brush-selection';
import { DataCellMultiSelection } from './data-cell-multi-selection';
import { EventController } from './event-controller';
import { RangeSelection } from './range-selection';
import { RowColumnResize } from './row-column-resize';
import { SelectedCellMove } from './selected-cell-move';

export class RootInteraction {
  public spreadsheet: SpreadSheet;

  public interactions = new Map<string, BaseEvent>();

  // 用来标记需要拦截的交互，interaction 和本身的 hover 等事件可能会有冲突，有冲突时在此屏蔽
  public intercepts = new Set<Intercept>();

  /**
   * hover有 keep-hover 态，是个计时器，hover后 800毫秒还在当前 cell 的情况下，该 cell 进入 keep-hover 状态
   * 在任何触发点击，或者点击空白区域时，说明已经不是 hover了，因此需要取消这个计时器。
   */
  private hoverTimer: number | null = null;

  public eventController: EventController;

  private defaultState: InteractionStateInfo = {
    cells: [],
    force: false,
  };

  public constructor(spreadsheet: SpreadSheet) {
    this.spreadsheet = spreadsheet;
    this.registerEventController();
    this.registerInteractions();
    window.addEventListener(
      'visibilitychange',
      this.onTriggerInteractionsResetEffect,
    );
  }

  /**
   * 销毁交互
   * @example s2.interaction.destroy()
   */
  public destroy() {
    this.interactions.clear();
    this.intercepts.clear();
    this.eventController.clear();
    this.clearHoverTimer();
    this.resetState();
    window.removeEventListener(
      'visibilitychange',
      this.onTriggerInteractionsResetEffect,
    );
  }

  /**
   * 重置交互
   * @example s2.interaction.reset()
   */
  public reset() {
    this.clearState();
    this.clearHoverTimer();
    this.intercepts.clear();
    this.spreadsheet.hideTooltip();
  }

  private onTriggerInteractionsResetEffect = () => {
    this.interactions.forEach((interaction) => {
      interaction.reset();
    });
  };

  /**
   * 设置交互状态
   * @example
      s2.interaction.setState({
        stateName: InteractionStateName.SELECTED,
        cells: [{
          "id": "root[&]浙江省[&]舟山市",
          "colIndex": -1,
          "rowIndex": 3,
          "type": "rowCell"
        }]
      })
   */
  public setState(interactionStateInfo: InteractionStateInfo) {
    setState(this.spreadsheet, interactionStateInfo);
  }

  /**
   * 获取交互状态
   * @example s2.interaction.getState()
   */
  public getState() {
    return (
      this.spreadsheet.store.get(INTERACTION_STATE_INFO_KEY) ||
      this.defaultState
    );
  }

  /**
   * 设置通过交互触发过更新的单元格
   * @example s2.interaction.setInteractedCells(dataCell)
   */
  public setInteractedCells(cell: S2CellType) {
    const interactedCells = this.getInteractedCells().concat([cell]);
    const state = this.getState();

    state.interactedCells = interactedCells;

    this.setState(state);
  }

  /**
   * 获取通过交互触发过更新的单元格
   * @example s2.interaction.getInteractedCells()
   */
  public getInteractedCells() {
    const currentState = this.getState();

    return currentState?.interactedCells || [];
  }

  /**
   * 重置交互状态
   * @example s2.interaction.resetState()
   */
  public resetState() {
    this.spreadsheet.store.set(INTERACTION_STATE_INFO_KEY, this.defaultState);
  }

  /**
   * 获取当前交互状态名
   * @example s2.interaction.getCurrentStateName()
   */
  public getCurrentStateName() {
    return this.getState().stateName;
  }

  /**
   * 是否和当前状态名相同
   * @example s2.interaction.isEqualStateName(InteractionStateName.SELECTED)
   */
  public isEqualStateName(stateName: InteractionStateName) {
    return this.getCurrentStateName() === stateName;
  }

  private isStateOf(stateName: InteractionStateName) {
    const currentState = this.getState();

    return currentState?.stateName === stateName;
  }

  /**
   * 是否是选中状态 (含单选,多选,圈选,全选)
   * @example s2.interaction.isSelectedState()
   */
  public isSelectedState() {
    return [
      InteractionStateName.SELECTED,
      InteractionStateName.ALL_SELECTED,
      InteractionStateName.ROW_CELL_BRUSH_SELECTED,
      InteractionStateName.COL_CELL_BRUSH_SELECTED,
      InteractionStateName.DATA_CELL_BRUSH_SELECTED,
    ].some((stateName) => {
      return this.isStateOf(stateName);
    });
  }

  /**
   * 是否是全选状态
   * @example s2.interaction.isAllSelectedState()
   */
  public isAllSelectedState() {
    return this.isStateOf(InteractionStateName.ALL_SELECTED);
  }

  /**
   * 是否是悬停聚焦状态
   * @example s2.interaction.isHoverFocusState()
   */
  public isHoverFocusState() {
    return this.isStateOf(InteractionStateName.HOVER_FOCUS);
  }

  /**
   * 是否是悬停状态
   * @example s2.interaction.isHoverState()
   */
  public isHoverState() {
    return this.isStateOf(InteractionStateName.HOVER);
  }

  /**
   * 是否是激活的单元格
   * @example s2.interaction.isActiveCell(cell)
   */
  public isActiveCell(cell: S2CellType): boolean {
    return !!this.getCells().find((meta) => cell.getMeta().id === meta.id);
  }

  /**
   * 是否是选中的单元格
   * @example s2.interaction.isSelectedCell(cell)
   */
  public isSelectedCell(cell: S2CellType): boolean {
    return this.isSelectedState() && this.isActiveCell(cell);
  }

  /**
   * 获取当前 interaction 记录的 Cells 元信息列表，包括不在可视区域内的格子
   * @example s2.interaction.getCells(CellType.DATA_CELL)
   */
  public getCells(cellType?: CellType[]): CellMeta[] {
    const currentState = this.getState();
    const cells = currentState?.cells || [];

    if (isNil(cellType)) {
      return cells;
    }

    return cells.filter((cell) => cellType.includes(cell.type));
  }

  /**
   * 获取已激活单元格 (不含非可视区域)
   * @example s2.interaction.getActiveCells()
   */
  public getActiveCells(): S2CellType[] {
    const ids = this.getCells().map((item) => item.id);
    const allCells = this.spreadsheet.facet?.getCells();

    // 这里的顺序要以 ids 中的顺序为准，代表点击 cell 的顺序
    return map(ids, (id) =>
      find(allCells, (cell) => cell?.getMeta()?.id === id),
    ).filter(Boolean) as S2CellType[];
  }

  /**
   * 清除单元格交互样式
   * @example s2.interaction.clearStyleIndependent()
   */
  public clearStyleIndependent() {
    if (
      !this.isSelectedState() &&
      !this.isHoverState() &&
      !this.isAllSelectedState()
    ) {
      return;
    }

    this.spreadsheet.facet.getDataCells().forEach((cell) => {
      cell.hideInteractionShape();
    });
  }

  /**
   * 获取未选中的单元格 (不含非可视区域)
   * @example s2.interaction.clearStyleIndependent()
   */
  public getUnSelectedDataCells() {
    return this.spreadsheet.facet
      .getDataCells()
      .filter((cell) => !this.isActiveCell(cell));
  }

  private scrollToCellByMeta(meta: ViewMeta | Node, animate = true) {
    if (!meta) {
      return;
    }

    const { facet } = this.spreadsheet;

    if (!facet.hRowScrollBar && !facet.hScrollBar && !facet.vScrollBar) {
      return;
    }

    this.scrollTo({
      rowHeaderOffsetX: {
        value: meta.x,
        animate,
      },
      offsetX: {
        value: meta.x,
        animate,
      },
      offsetY: {
        value: meta.y,
        animate,
      },
    });
  }

  /**
   * 滚动至指定位置
   * @example
      s2.interaction.scrollTo({
        offsetX: { value: 100, animate: true },
        offsetY: { value: 100, animate: true },
      })
   */
  public scrollTo(offsetConfig: ScrollOffsetConfig) {
    const { facet } = this.spreadsheet;
    const { scrollX, scrollY, rowHeaderScrollX } = facet.getScrollOffset();

    const config: ScrollOffsetConfig = {
      offsetX: {
        value: scrollX,
        animate: true,
      },
      offsetY: {
        value: scrollY,
        animate: true,
      },
      rowHeaderOffsetX: {
        value: rowHeaderScrollX,
        animate: true,
      },
    };

    facet.updateScrollOffset(
      customMerge<ScrollOffsetConfig>(config, offsetConfig),
    );
  }

  /**
   * 滚动至指定单元格节点
   * @example s2.interaction.scrollToNode(rowNode, false)
   */
  public scrollToNode(meta: ViewMeta | Node, animate = true) {
    this.scrollToCellByMeta(meta, animate);
  }

  /**
   * 滚动至指定单元格
   * @example s2.interaction.scrollToCell(dataCell, false)
   */
  public scrollToCell(cell: S2CellType, animate = true) {
    this.scrollToCellByMeta(cell.getMeta(), animate);
  }

  /**
   * 滚动至指定单元格 id 对应的位置
   * @example s2.interaction.scrollToCellById('root[&]四川省[&]成都市', false)
   */
  public scrollToCellById(id: string, animate = true) {
    if (!id) {
      return;
    }

    // 兼容不在可视区域, 未实例化的行列头单元格
    const headerNodes = this.spreadsheet.facet.getHeaderNodes();
    const viewMetas = this.spreadsheet.facet
      .getDataCells()
      .map((cell) => cell.getMeta());

    const cellMeta = [...headerNodes, ...viewMetas].find(
      (meta) => meta.id === id,
    );

    if (!cellMeta) {
      return;
    }

    this.scrollToCellByMeta(cellMeta, animate);
  }

  /**
   * 滚动至顶部
   * @example s2.interaction.scrollToTop(true)
   */
  public scrollToTop(animate = true) {
    this.scrollTo({
      offsetY: {
        value: 0,
        animate,
      },
    });
  }

  /**
   * 滚动至右边
   * @example s2.interaction.scrollToRight(true)
   */
  public scrollToRight(animate = true) {
    this.scrollTo({
      offsetX: {
        value: this.spreadsheet.facet.panelBBox.maxX,
        animate,
      },
    });
  }

  /**
   * 滚动至底部
   * @example s2.interaction.scrollToBottom(true)
   */
  public scrollToBottom(animate = true) {
    this.scrollTo({
      offsetY: {
        value: this.spreadsheet.facet.panelBBox.maxY,
        animate,
      },
    });
  }

  /**
   * 滚动至左边
   * @example s2.interaction.scrollToLeft(true)
   */
  public scrollToLeft(animate = true) {
    this.scrollTo({
      offsetX: {
        value: 0,
        animate,
      },
    });
  }

  /**
   * 全选
   * @example s2.interaction.selectAll()
   */
  public selectAll() {
    this.changeState({
      stateName: InteractionStateName.ALL_SELECTED,
    });

    this.addIntercepts([InterceptType.HOVER]);
    this.updateCells(this.spreadsheet.facet.getCells());
  }

  /**
   * 高亮指定单元格 (可视范围内)
   * @example s2.interaction.highlightCell(dataCell)
   */
  public highlightCell(cell: S2CellType) {
    this.changeCell({
      cell,
      stateName: InteractionStateName.HOVER,
    });
  }

  /**
   * 选中指定单元格 (可视范围内)
   * @example s2.interaction.selectCell(dataCell)
   */
  public selectCell(cell: S2CellType) {
    this.changeCell({
      cell,
      stateName: InteractionStateName.SELECTED,
    });
  }

  /**
   * 改变指定单元格状态 (如: 选中/高亮/多选等) (可视范围内)
   * @example
     s2.interaction.changeCell({
      cell: rowCell,
      stateName: InteractionStateName.SELECTED,
      isMultiSelection: false,
      scrollIntoView: false,
    });
   */
  public changeCell(options: ChangeCellOptions = {} as ChangeCellOptions) {
    const {
      cell,
      stateName = InteractionStateName.SELECTED,
      scrollIntoView = true,
    } = options;

    if (isEmpty(cell)) {
      return;
    }

    const meta = cell?.getMeta?.() as Node;

    if (!meta || isNil(meta?.x)) {
      return;
    }

    this.addIntercepts([InterceptType.HOVER]);

    const isHierarchyTree = this.spreadsheet.isHierarchyTreeType();
    const isColCell = cell?.cellType === CellType.COL_CELL;
    const lastState = this.getState();
    const isSelectedCell = this.isSelectedCell(cell);
    const isMultiSelected = options?.isMultiSelection && this.isSelectedState();

    // 如果是已选中的单元格, 则取消选中, 兼容行列多选 (含叶子节点)
    let childrenNodes = isSelectedCell
      ? []
      : this.spreadsheet.facet.getCellChildrenNodes(cell);
    let selectedCells = isSelectedCell ? [] : [getCellMeta(cell)];

    if (isMultiSelected) {
      selectedCells = concat(lastState?.cells || [], selectedCells);
      childrenNodes = concat(lastState?.nodes || [], childrenNodes);

      if (isSelectedCell) {
        selectedCells = selectedCells.filter(({ id }) => id !== meta.id);
        childrenNodes = childrenNodes.filter(
          (node) => !node?.id.includes(meta.id),
        );
      }
    }

    if (isEmpty(selectedCells)) {
      this.reset();
      this.spreadsheet.emit(S2Event.GLOBAL_SELECTED, this.getActiveCells());

      return;
    }

    const nodes = isEmpty(childrenNodes)
      ? [cell.getMeta() as Node]
      : childrenNodes;

    // 兼容行列多选 (高亮 行/列头 以及相对应的数值单元格)
    this.changeState({
      cells: selectedCells,
      nodes,
      stateName,
    });

    const selectedCellIds = selectedCells.map(({ id }) => id);

    this.updateCells(this.spreadsheet.facet.getHeaderCells(selectedCellIds));

    // 平铺模式或者是树状模式下的列头单元格, 高亮子节点
    if (!isHierarchyTree || isColCell) {
      this.highlightNodes(childrenNodes);
    }

    // 如果不在可视范围, 自动滚动.
    if (scrollIntoView) {
      this.scrollToCell(cell);
    }

    this.spreadsheet.emit(S2Event.GLOBAL_SELECTED, this.getActiveCells());

    return true;
  }

  /**
   * 高亮节点对应的单元格
   * @example s2.interaction.highlightNodes([node])
   */
  public highlightNodes = (nodes: Node[] = []) => {
    nodes.forEach((node) => {
      node?.belongsCell?.updateByState(
        InteractionStateName.SELECTED,
        node.belongsCell,
      );
    });
  };

  /**
   * 合并单元格
   * @example s2.interaction.mergeCells()
   */
  public mergeCells = (cellsInfo?: MergedCellInfo[], hideData?: boolean) => {
    mergeCell(this.spreadsheet, cellsInfo, hideData);
  };

  /**
   * 取消合并单元格
   * @example s2.interaction.unmergeCell(mergedCell)
   */
  public unmergeCell = (removedCell: MergedCell) => {
    unmergeCell(this.spreadsheet, removedCell);
  };

  /**
   * 隐藏列头
   * @example s2.interaction.hideColumns(['city'])
   */
  public async hideColumns(
    hiddenColumnFields: string[] = [],
    forceRender = true,
  ): Promise<void> {
    await hideColumnsByThunkGroup(
      this.spreadsheet,
      hiddenColumnFields,
      forceRender,
    );
  }

  private getBrushSelectionInfo(
    brushSelection?: boolean | BrushSelectionOptions,
  ): BrushSelectionInfo {
    if (isBoolean(brushSelection)) {
      return {
        dataCellBrushSelection: brushSelection,
        rowCellBrushSelection: brushSelection,
        colCellBrushSelection: brushSelection,
      };
    }

    return {
      dataCellBrushSelection: brushSelection?.dataCell ?? false,
      rowCellBrushSelection: brushSelection?.rowCell ?? false,
      colCellBrushSelection: brushSelection?.colCell ?? false,
    };
  }

  private getDefaultInteractions() {
    const {
      resize,
      brushSelection,
      multiSelection,
      rangeSelection,
      selectedCellMove,
    } = this.spreadsheet.options.interaction!;
    const {
      dataCellBrushSelection,
      rowCellBrushSelection,
      colCellBrushSelection,
    } = this.getBrushSelectionInfo(brushSelection);

    return [
      {
        key: InteractionName.CORNER_CELL_CLICK,
        interaction: CornerCellClick,
      },
      {
        key: InteractionName.DATA_CELL_CLICK,
        interaction: DataCellClick,
      },
      {
        key: InteractionName.ROW_COLUMN_CLICK,
        interaction: RowColumnClick,
      },
      {
        key: InteractionName.ROW_TEXT_CLICK,
        interaction: RowTextClick,
      },
      {
        key: InteractionName.MERGED_CELLS_CLICK,
        interaction: MergedCellClick,
      },
      {
        key: InteractionName.HOVER,
        interaction: HoverEvent,
        enable: !isMobile(),
      },
      {
        key: InteractionName.DATA_CELL_BRUSH_SELECTION,
        interaction: DataCellBrushSelection,
        enable: !isMobile() && dataCellBrushSelection,
      },
      {
        key: InteractionName.ROW_CELL_BRUSH_SELECTION,
        interaction: RowCellBrushSelection,
        enable: !isMobile() && rowCellBrushSelection,
      },
      {
        key: InteractionName.COL_CELL_BRUSH_SELECTION,
        interaction: ColCellBrushSelection,
        enable: !isMobile() && colCellBrushSelection,
      },
      {
        key: InteractionName.COL_ROW_RESIZE,
        interaction: RowColumnResize,
        enable: !isMobile() && resize,
      },
      {
        key: InteractionName.DATA_CELL_MULTI_SELECTION,
        interaction: DataCellMultiSelection,
        enable: !isMobile() && multiSelection,
      },
      {
        key: InteractionName.RANGE_SELECTION,
        interaction: RangeSelection,
        enable: !isMobile() && rangeSelection,
      },
      {
        key: InteractionName.SELECTED_CELL_MOVE,
        interaction: SelectedCellMove,
        enable: !isMobile() && selectedCellMove,
      },
    ];
  }

  private registerInteractions() {
    const { customInteractions } = this.spreadsheet.options.interaction!;

    this.interactions.clear();

    const defaultInteractions = this.getDefaultInteractions();

    defaultInteractions.forEach(({ key, interaction: Interaction, enable }) => {
      if (enable !== false) {
        this.interactions.set(key, new Interaction(this.spreadsheet));
      }
    });

    if (!isEmpty(customInteractions)) {
      forEach(customInteractions, (customInteraction: CustomInteraction) => {
        const CustomInteractionClass = customInteraction.interaction;

        this.interactions.set(
          customInteraction.key,
          new CustomInteractionClass(this.spreadsheet),
        );
      });
    }
  }

  private registerEventController() {
    this.eventController = new EventController(this.spreadsheet);
  }

  public draw() {
    this.spreadsheet.container.render();
  }

  public clearState() {
    if (clearState(this.spreadsheet)) {
      this.draw();
    }
  }

  /**
   * 改变单元格交互状态后，进行更新和重新绘制
   * @example
      s2.interaction.changeState({
        cells: [{ id: 'city', colIndex: 1, rowIndex : 2, type: 'rowCell' }],
        stateName: InteractionStateName.SELECTED,
        force: false
      })
   */
  public changeState(interactionStateInfo: InteractionStateInfo) {
    const { interaction } = this.spreadsheet;
    const {
      cells = [],
      force,
      stateName,
      onUpdateCells,
    } = interactionStateInfo;

    if (isEmpty(cells) && stateName === InteractionStateName.SELECTED) {
      if (force) {
        interaction.changeState({
          cells: [],
          stateName: InteractionStateName.UNSELECTED,
        });
      }

      return;
    }

    // 之前是全选状态，需要清除格子的样式
    if (this.getCurrentStateName() === InteractionStateName.ALL_SELECTED) {
      this.clearStyleIndependent();
    }

    this.clearState();
    this.setState(interactionStateInfo);

    // 更新单元格
    const update = () => {
      this.updateAllDataCells();
    };

    if (onUpdateCells) {
      onUpdateCells(this, update);
    } else {
      update();
    }

    this.draw();
  }

  /**
   * 更新所有数值单元格
   * @example s2.interaction.updateAllDataCells()
   */
  public updateAllDataCells() {
    this.updateCells(this.spreadsheet.facet.getDataCells());
  }

  /**
   * 更新指定单元格
   * @example s2.interaction.updateCells([rowCell, dataCell])
   */
  public updateCells(cells: S2CellType[] = []) {
    cells.forEach((cell) => {
      cell.update();
    });
  }

  /**
   * 添加交互拦截
   * @example s2.interaction.addIntercepts([InterceptType.HOVER])
   */
  public addIntercepts(interceptTypes: InterceptType[] = []) {
    interceptTypes.forEach((interceptType) => {
      this.intercepts.add(interceptType);
    });
  }

  /**
   * 是否有指定交互拦截
   * @example s2.interaction.hasIntercepts([InterceptType.HOVER])
   */
  public hasIntercepts(interceptTypes: InterceptType[] = []) {
    return interceptTypes.some((interceptType) =>
      this.intercepts.has(interceptType),
    );
  }

  /**
   * 移除交互拦截
   * @example s2.interaction.removeIntercepts([InterceptType.HOVER])
   */
  public removeIntercepts(interceptTypes: InterceptType[] = []) {
    interceptTypes.forEach((interceptType) => {
      this.intercepts.delete(interceptType);
    });
  }

  public clearHoverTimer() {
    clearTimeout(this.hoverTimer!);
  }

  public setHoverTimer(timer: number) {
    this.hoverTimer = timer;
  }

  public getHoverTimer() {
    return this.hoverTimer;
  }

  public getSelectedCellHighlight(): InteractionCellHighlightOptions {
    const { selectedCellHighlight } = this.spreadsheet.options.interaction!;

    if (isBoolean(selectedCellHighlight)) {
      return {
        rowHeader: selectedCellHighlight,
        colHeader: selectedCellHighlight,
        currentRow: selectedCellHighlight,
        currentCol: selectedCellHighlight,
      };
    }

    const {
      rowHeader = false,
      colHeader = false,
      currentRow = false,
      currentCol = false,
    } = (selectedCellHighlight as unknown as InteractionCellHighlightOptions) ??
    {};

    return {
      rowHeader,
      colHeader,
      currentRow,
      currentCol,
    };
  }

  public getHoverAfterScroll(): boolean {
    return this.spreadsheet.options.interaction!.hoverAfterScroll!;
  }

  public getHoverHighlight(): InteractionCellHighlightOptions {
    const { hoverHighlight } = this.spreadsheet.options.interaction!;

    if (isBoolean(hoverHighlight)) {
      return {
        rowHeader: hoverHighlight,
        colHeader: hoverHighlight,
        currentRow: hoverHighlight,
        currentCol: hoverHighlight,
      };
    }

    const {
      rowHeader = false,
      colHeader = false,
      currentRow = false,
      currentCol = false,
    } = hoverHighlight ?? ({} as InteractionCellHighlightOptions);

    return {
      rowHeader,
      colHeader,
      currentRow,
      currentCol,
    };
  }

  public getBrushSelection(): BrushSelectionOptions {
    const { brushSelection } = this.spreadsheet.options.interaction!;

    if (isBoolean(brushSelection)) {
      return {
        dataCell: brushSelection,
        rowCell: brushSelection,
        colCell: brushSelection,
      };
    }

    const {
      dataCell = false,
      rowCell = false,
      colCell = false,
    } = brushSelection ?? ({} as BrushSelectionOptions);

    return {
      dataCell,
      rowCell,
      colCell,
    };
  }
}
