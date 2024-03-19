import type { FederatedPointerEvent as CanvasEvent } from '@antv/g';
import { S2Event } from '../../../common/constant';
import { BaseEvent, type BaseEventImplement } from '../../base-event';

export class ColumnTextClick extends BaseEvent implements BaseEventImplement {
  public bindEvents() {
    this.bindColumnTextClick();
  }

  private bindColumnTextClick() {
    this.spreadsheet.on(S2Event.COL_CELL_CLICK, (event) => {
      if (this.isLinkFieldText(event.target)) {
        this.emitLinkFieldClickEvent(event);
      }
    });
  }

  private emitLinkFieldClickEvent(event: CanvasEvent) {
    const { cellData } = this.getCellAppendInfo(event.target);
    const { valueField: field, data: record } = cellData!;

    this.spreadsheet.emit(S2Event.GLOBAL_LINK_FIELD_JUMP, {
      cellData: cellData!,
      field,
      record: Object.assign({ rowIndex: cellData?.rowIndex }, record),
    });
  }
}
