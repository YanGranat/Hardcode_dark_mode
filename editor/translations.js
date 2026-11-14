(function exposeEditorText(global) {
  const TEXT = {
    en: {
      picker: {
        title: "Exclude element",
        hint: "Click the element you want to keep unchanged.",
        chosen: "Check the colors, then save the exclusion.",
        larger: "Larger", smaller: "Smaller",
        largerHint: "Select the whole block (up arrow)",
        smallerHint: "Return to the smaller element (down arrow)",
        move: "Move toolbar to bottom", moveUp: "Move toolbar to top",
        save: "Save", cancel: "Cancel",
        failed: "Could not save. Try again.",
        unavailable: "Choose another element.", saving: "Saving…",
        limit: "Too many exclusions. Remove unused entries in the popup.",
        timeout: "No response. The exclusion may have been saved; check the popup.",
        one: "This element", similar: "Similar elements", scope: "Apply the rule to",
        noGroup: "No safe group is available. Choose another block.",
        matches: "Matches: ",
        containerGroup: "Elements of the same type inside matching containers, including future elements.",
        unsafe: "Original colors could not be preserved for this selection. Adjust the block or exception boundaries.",
        addException: "Add exception", applyException: "Add", updateException: "Apply", back: "Back",
        exceptionTitle: "Exception inside block",
        exceptionHint: "Click an element inside the selected block.",
        exceptionChosen: "Check the exception, then add it to the block.",
        exceptionList: "Exceptions", rootLabel: "Block: ",
        insideOnly: "Choose an element inside the block. The block itself and its ancestors cannot be excluded.",
        conflict: "The rule already exists or has changed. Reopen the saved block.",
        removeException: "Remove exception", editException: "Edit exception",
        emptyExceptions: "No exceptions yet.",
        rootMissing: "The block is temporarily missing. Your draft is retained.",
        legacyTitle: "Old site exceptions",
        legacyHint: "Removing these exceptions affects the whole site. Changes apply when you save.",
        legacyConflict: "An old site exception disables this entire block. Remove it in the list below.",
        removeLegacy: "Remove old site exception",
        coveringConflict: "This block is excluded by {block}. Edit that block's exceptions in the list."
      },
      invert: {
        title: "Configure block", hint: "Click the block you want to darken.",
        chosen: "Check the result, then save the rule.",
        limit: "Too many rules. Remove unused entries in the popup.",
        timeout: "No response. The rule may have been saved; check the popup."
      },
      matches: {
        count: "Matches", rendered: "Rendered", previous: "Previous", next: "Next", close: "Close",
        moveDown: "Move panel down", moveUp: "Move panel up",
        overflow: "Too many matches. Narrow the rule.", empty: "No matches on this page."
      }
    },
    ru: {
      picker: {
        title: "Исключить элемент",
        hint: "Нажмите на нужный элемент страницы.",
        chosen: "Проверьте цвета и сохраните исключение.",
        larger: "Крупнее", smaller: "Меньше",
        largerHint: "Выбрать весь блок (стрелка вверх)",
        smallerHint: "Вернуться к меньшему элементу (стрелка вниз)",
        move: "Переместить панель вниз", moveUp: "Переместить панель вверх",
        save: "Сохранить", cancel: "Отмена",
        failed: "Не удалось сохранить. Попробуйте ещё раз.",
        unavailable: "Выберите другой элемент.", saving: "Сохранение…",
        limit: "Слишком много исключений. Удалите ненужные в попапе.",
        timeout: "Ответ не получен. Исключение могло сохраниться — проверьте в попапе.",
        one: "Этот элемент", similar: "Похожие элементы", scope: "К чему применить правило",
        noGroup: "Не удалось выделить безопасную группу. Выберите другой блок.",
        matches: "Совпадений: ",
        containerGroup: "Элементы того же типа внутри таких же контейнеров, включая появившиеся позже.",
        unsafe: "Для этого выделения не удалось сохранить исходные цвета. Измените границы блока или исключения.",
        addException: "Добавить исключение", applyException: "Добавить", updateException: "Применить", back: "Назад",
        exceptionTitle: "Исключение внутри блока",
        exceptionHint: "Нажмите на элемент внутри выбранного блока.",
        exceptionChosen: "Проверьте исключение и добавьте его к блоку.",
        exceptionList: "Исключения", rootLabel: "Блок: ",
        insideOnly: "Выберите элемент внутри блока. Сам блок и его предков исключить нельзя.",
        conflict: "Правило уже существует или его настройки изменились. Откройте сохранённый блок заново.",
        removeException: "Убрать исключение", editException: "Изменить исключение",
        emptyExceptions: "Исключений пока нет.",
        rootMissing: "Блок временно не найден. Черновик не потерян.",
        legacyTitle: "Старые исключения сайта",
        legacyHint: "Удаление этих исключений повлияет на весь сайт. Изменения применятся после сохранения.",
        legacyConflict: "Старое исключение сайта отключает инверсию всего блока. Удалите его в списке ниже.",
        removeLegacy: "Удалить старое исключение сайта",
        coveringConflict: "Этот блок исключён правилом «{block}». Измените исключения того блока в списке."
      },
      invert: {
        title: "Настроить блок", hint: "Нажмите на блок, который нужно затемнить.",
        chosen: "Проверьте результат и сохраните правило.",
        limit: "Слишком много правил. Удалите ненужные в попапе.",
        timeout: "Ответ не получен. Правило могло сохраниться — проверьте в попапе."
      },
      matches: {
        count: "Совпадений", rendered: "Отображается", previous: "Предыдущее", next: "Следующее", close: "Закрыть",
        moveDown: "Переместить панель вниз", moveUp: "Переместить панель вверх",
        overflow: "Слишком много совпадений. Уточните правило.", empty: "На этой странице совпадений нет."
      }
    },
    uk: {
      picker: {
        title: "Виключити елемент",
        hint: "Натисніть на потрібний елемент сторінки.",
        chosen: "Перевірте кольори та збережіть виняток.",
        larger: "Більше", smaller: "Менше",
        largerHint: "Вибрати весь блок (стрілка вгору)",
        smallerHint: "Повернутися до меншого елемента (стрілка вниз)",
        move: "Перемістити панель униз", moveUp: "Перемістити панель угору",
        save: "Зберегти", cancel: "Скасувати",
        failed: "Не вдалося зберегти. Спробуйте ще раз.",
        unavailable: "Виберіть інший елемент.", saving: "Збереження…",
        limit: "Забагато винятків. Видаліть непотрібні в попапі.",
        timeout: "Відповідь не отримано. Виняток міг зберегтися — перевірте в попапі.",
        one: "Цей елемент", similar: "Схожі елементи", scope: "До чого застосувати правило",
        noGroup: "Не вдалося вибрати безпечну групу. Виберіть інший блок.",
        matches: "Збігів: ",
        containerGroup: "Елементи того самого типу в таких самих контейнерах, зокрема ті, що з’являться пізніше.",
        unsafe: "Не вдалося зберегти початкові кольори цього виділення. Змініть межі блока або винятку.",
        addException: "Додати виняток", applyException: "Додати", updateException: "Застосувати", back: "Назад",
        exceptionTitle: "Виняток усередині блока",
        exceptionHint: "Натисніть на елемент усередині вибраного блока.",
        exceptionChosen: "Перевірте виняток і додайте його до блока.",
        exceptionList: "Винятки", rootLabel: "Блок: ",
        insideOnly: "Виберіть елемент усередині блока. Сам блок і його предків виключити не можна.",
        conflict: "Правило вже існує або його налаштування змінилися. Відкрийте збережений блок знову.",
        removeException: "Видалити виняток", editException: "Змінити виняток",
        emptyExceptions: "Винятків поки немає.",
        rootMissing: "Блок тимчасово не знайдено. Чернетка не втрачена.",
        legacyTitle: "Старі винятки сайту",
        legacyHint: "Видалення цих винятків вплине на весь сайт. Зміни буде застосовано після збереження.",
        legacyConflict: "Старий виняток сайту вимикає інверсію всього блока. Видаліть його зі списку нижче.",
        removeLegacy: "Видалити старий виняток сайту",
        coveringConflict: "Цей блок виключено правилом «{block}». Змініть винятки того блока в списку."
      },
      invert: {
        title: "Налаштувати блок", hint: "Натисніть на блок, який потрібно затемнити.",
        chosen: "Перевірте результат і збережіть правило.",
        limit: "Забагато правил. Видаліть непотрібні в попапі.",
        timeout: "Відповідь не отримано. Правило могло зберегтися — перевірте в попапі."
      },
      matches: {
        count: "Збігів", rendered: "Відображено", previous: "Попередній", next: "Наступний", close: "Закрити",
        moveDown: "Перемістити панель униз", moveUp: "Перемістити панель угору",
        overflow: "Забагато збігів. Уточніть правило.", empty: "На цій сторінці немає збігів."
      }
    },
    de: {
      picker: {
        title: "Element ausschließen",
        hint: "Klicke auf das Element, das unverändert bleiben soll.",
        chosen: "Prüfe die Farben und speichere die Ausnahme.",
        larger: "Größer", smaller: "Kleiner",
        largerHint: "Den ganzen Block auswählen (Pfeil nach oben)",
        smallerHint: "Zum kleineren Element zurückkehren (Pfeil nach unten)",
        move: "Leiste nach unten verschieben", moveUp: "Leiste nach oben verschieben",
        save: "Speichern", cancel: "Abbrechen",
        failed: "Speichern fehlgeschlagen. Versuche es erneut.",
        unavailable: "Wähle ein anderes Element.", saving: "Wird gespeichert…",
        limit: "Zu viele Ausnahmen. Entferne ungenutzte Einträge im Popup.",
        timeout: "Keine Antwort. Die Ausnahme wurde möglicherweise gespeichert; prüfe das Popup.",
        one: "Dieses Element", similar: "Ähnliche Elemente", scope: "Regel anwenden auf",
        noGroup: "Keine sichere Gruppe verfügbar. Wähle einen anderen Block.",
        matches: "Treffer: ",
        containerGroup: "Elemente desselben Typs in passenden Containern, auch künftig hinzugefügte Elemente.",
        unsafe: "Die Originalfarben konnten für diese Auswahl nicht erhalten werden. Passe die Block- oder Ausnahmegrenzen an.",
        addException: "Ausnahme hinzufügen", applyException: "Hinzufügen", updateException: "Anwenden", back: "Zurück",
        exceptionTitle: "Ausnahme innerhalb des Blocks",
        exceptionHint: "Klicke auf ein Element innerhalb des ausgewählten Blocks.",
        exceptionChosen: "Prüfe die Ausnahme und füge sie dem Block hinzu.",
        exceptionList: "Ausnahmen", rootLabel: "Block: ",
        insideOnly: "Wähle ein Element im Block. Der Block selbst und übergeordnete Elemente können nicht ausgeschlossen werden.",
        conflict: "Die Regel besteht bereits oder wurde geändert. Öffne den gespeicherten Block erneut.",
        removeException: "Ausnahme entfernen", editException: "Ausnahme bearbeiten",
        emptyExceptions: "Noch keine Ausnahmen.",
        rootMissing: "Der Block ist vorübergehend nicht vorhanden. Dein Entwurf bleibt erhalten.",
        legacyTitle: "Alte Websiteausnahmen",
        legacyHint: "Das Entfernen dieser Ausnahmen betrifft die ganze Website. Änderungen werden beim Speichern angewendet.",
        legacyConflict: "Eine alte Websiteausnahme deaktiviert die Invertierung dieses ganzen Blocks. Entferne sie unten.",
        removeLegacy: "Alte Websiteausnahme entfernen",
        coveringConflict: "Dieser Block ist durch {block} ausgeschlossen. Bearbeite die Ausnahmen dieses Blocks in der Liste."
      },
      invert: {
        title: "Block anpassen", hint: "Klicke auf den Block, den du abdunkeln möchtest.",
        chosen: "Prüfe das Ergebnis und speichere die Regel.",
        limit: "Zu viele Regeln. Entferne ungenutzte Einträge im Popup.",
        timeout: "Keine Antwort. Die Regel wurde möglicherweise gespeichert; prüfe das Popup."
      },
      matches: {
        count: "Treffer", rendered: "Angezeigt", previous: "Zurück", next: "Weiter", close: "Schließen",
        moveDown: "Leiste nach unten verschieben", moveUp: "Leiste nach oben verschieben",
        overflow: "Zu viele Treffer. Grenze die Regel ein.", empty: "Keine Treffer auf dieser Seite."
      }
    },
    es: {
      picker: {
        title: "Excluir elemento",
        hint: "Haz clic en el elemento que quieras mantener sin cambios.",
        chosen: "Comprueba los colores y guarda la excepción.",
        larger: "Ampliar", smaller: "Reducir",
        largerHint: "Seleccionar todo el bloque (flecha arriba)",
        smallerHint: "Volver al elemento más pequeño (flecha abajo)",
        move: "Mover barra abajo", moveUp: "Mover barra arriba",
        save: "Guardar", cancel: "Cancelar",
        failed: "No se pudo guardar. Inténtalo de nuevo.",
        unavailable: "Elige otro elemento.", saving: "Guardando…",
        limit: "Demasiadas exclusiones. Elimina las que no uses en el popup.",
        timeout: "Sin respuesta. Es posible que la exclusión se haya guardado; compruébalo en el popup.",
        one: "Este elemento", similar: "Elementos similares", scope: "Aplicar la regla a",
        noGroup: "No hay un grupo seguro disponible. Elige otro bloque.",
        matches: "Coincidencias: ",
        containerGroup: "Elementos del mismo tipo en contenedores coincidentes, incluidos los que aparezcan después.",
        unsafe: "No se pudieron conservar los colores originales de esta selección. Ajusta los límites del bloque o la excepción.",
        addException: "Añadir excepción", applyException: "Añadir", updateException: "Aplicar", back: "Volver",
        exceptionTitle: "Excepción dentro del bloque",
        exceptionHint: "Haz clic en un elemento dentro del bloque seleccionado.",
        exceptionChosen: "Comprueba la excepción y añádela al bloque.",
        exceptionList: "Excepciones", rootLabel: "Bloque: ",
        insideOnly: "Elige un elemento dentro del bloque. No se pueden excluir el bloque ni sus elementos superiores.",
        conflict: "La regla ya existe o ha cambiado. Vuelve a abrir el bloque guardado.",
        removeException: "Eliminar excepción", editException: "Editar excepción",
        emptyExceptions: "Aún no hay excepciones.",
        rootMissing: "El bloque no está disponible temporalmente. Se conserva el borrador.",
        legacyTitle: "Excepciones antiguas del sitio",
        legacyHint: "Eliminar estas excepciones afecta a todo el sitio. Los cambios se aplican al guardar.",
        legacyConflict: "Una excepción antigua del sitio desactiva la inversión de todo este bloque. Elimínala de la lista.",
        removeLegacy: "Eliminar excepción antigua del sitio",
        coveringConflict: "Este bloque está excluido por {block}. Edita las excepciones de ese bloque en la lista."
      },
      invert: {
        title: "Configurar bloque", hint: "Haz clic en el bloque que quieras oscurecer.",
        chosen: "Comprueba el resultado y guarda la regla.",
        limit: "Demasiadas reglas. Elimina las que no uses en el popup.",
        timeout: "Sin respuesta. Es posible que la regla se haya guardado; compruébalo en el popup."
      },
      matches: {
        count: "Coincidencias", rendered: "Mostradas", previous: "Anterior", next: "Siguiente", close: "Cerrar",
        moveDown: "Mover panel abajo", moveUp: "Mover panel arriba",
        overflow: "Demasiadas coincidencias. Acota la regla.", empty: "No hay coincidencias en esta página."
      }
    }
  };

  function picker(language, invert) {
    const selected = TEXT[HdmLanguages.normalize(language)];
    return { ...TEXT.en.picker, ...selected.picker, ...(invert ? { ...TEXT.en.invert, ...selected.invert } : {}) };
  }

  function matches(language) {
    return { ...TEXT.en.matches, ...TEXT[HdmLanguages.normalize(language)].matches };
  }

  global.HdmEditorText = { messages: TEXT, picker, matches };
})(globalThis);
