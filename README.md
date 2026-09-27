# ONEFIX · Servidor de nómina con Neon

Primera versión de prueba para organizar empleados y subcontratistas de ONEFIX Construction. La app se inicia vacía y no importa los tres archivos históricos.

## Funciones incluidas

- Fichas de personas, obras, contratos con número único y ampliaciones justificadas.
- Producción registra la asistencia diaria con proyecto o ubicación y responsable obligatorios. Una jornada exige hora de entrada y salida; calcula las horas regulares descontando descanso y horas extra indicadas y admite turnos nocturnos. Una ausencia exige proyecto o ubicación y responsable, pero no permite horarios, descanso, horas ni bono. La API rechaza campos obligatorios vacíos o compuestos solo por espacios y registra la acción del usuario de Producción en auditoría. Los registros anteriores se conservan con los campos nuevos en blanco y descanso de 0 minutos; al editarlos se exigen los campos aplicables.
- Tareas de subcontratistas confirmadas por Producción. Una tarea ligada a contrato no puede superar el monto autorizado acumulado.
- Anticipos, préstamos y daños. El registro de daños requiere una foto y el nombre del manager de obra. Si los descuentos pendientes exceden lo devengado por una persona, se bloquea el cierre hasta corregir los importes; no se aplica parcialmente un descuento.
- Correo y clave de 12 caracteres como mínimo; invitaciones privadas de un solo uso para Producción, Administración y Gerencia. El servidor impone permisos y registra acciones relevantes.
- Cierre de sábado a viernes, disponible desde el domingo siguiente. Administración marca cada partida del listado como revisada, puede desmarcarla antes de enviar, añade una nota opcional y solo envía a Gerencia cuando todas estén revisadas. Gerencia ve el listado, la nota y la identidad/fecha de revisión; confirma el neto y aprueba. Los permisos y el orden se validan también en la API, con auditoría. El PDF del listado muestra los estados y las personas que revisaron y aprobaron. Los períodos históricos con la regla anterior se conservan y no pueden solaparse con cierres nuevos.
- El listado permite a Administración filtrar las partidas pendientes sin alterar los totales semanales. En móvil, cada persona se presenta con conceptos e importes legibles sin desplazamiento horizontal. El PDF del listado incluye el desglose de conceptos por persona y conserva los importes y el estado de revisión.
- Administración puede guardar o quitar una observación de hasta 500 caracteres por persona mientras la nómina esté en borrador. Al cambiar una observación guardada se anula la marca de revisión de esa partida hasta comprobarla nuevamente. Gerencia solo la lee; el PDF del listado también la muestra. Una observación sin guardar bloquea el envío desde la interfaz.
- Cada cierre nuevo guarda el devengado bruto por persona y proyecto, con horas efectivas de asistencia y tareas aprobadas. El sueldo fijo se reparte proporcionalmente a las horas efectivas por obra (regulares y extras); el sueldo por hora según horas regulares y horas extra a su tarifa, y los bonos se atribuyen a la obra de la asistencia. Si no hay horas que permitan distribuir el sueldo fijo, figura como «Sin proyecto asignado». El listado y «Proyectos PDF» muestran los subtotales por obra; anticipos, préstamos, daños, ausencias y neto quedan solo por persona. Las tareas atrasadas entran en el cierre que las paga. Los cierres anteriores a esta función aparecen como «Sin desglose histórico»: no se les atribuye retrospectivamente un proyecto.
- Pago individual con método y referencia. PDF protegido, generado bajo demanda, del listado, reporte contable operativo y recibos individuales después de aprobar.
- Registro local de pagos sin red, sincronización al reconectar y detección de duplicados o conflictos entre dispositivos. El pago no se marca como pagado mientras esté pendiente.
- Evita repetir la semana o incluir dos veces la misma tarea. Una nómina no aprobada puede retirarse para corregir la fuente, conservando su revisión histórica; una aprobada no puede retirarse.

## Cálculo

- Empleado por hora: horas registradas × tarifa + horas extra × tarifa extra + bonos.
- Empleado fijo: sueldo semanal completo + bonos; las horas extra solo se pagan adicionalmente si Gerencia lo autoriza para esa persona y fija la tarifa por hora. Si no, las horas extra se registran sin pago. Un día sin registro no se interpreta como ausencia.
- Ausencias de sueldo fijo: Administración fija un descuento global USD por persona y semana antes de generar la nómina, incluso si el importe es 0. Cada ausencia sin ese importe bloquea el cierre. El descuento aparece separado en el detalle y se resta del bruto junto con los anticipos, préstamos y daños pendientes.
- Subcontratista: suma de tareas confirmadas no asignadas a otra nómina con fecha hasta el viernes del cierre. Así se pueden incluir tareas aprobadas tarde en la siguiente semana.
- Neto: bruto menos el descuento por ausencias y todos los descuentos pendientes hasta el viernes. Si la suma excede el bruto, se bloquea toda la nómina sin aplicar parcialmente los saldos.
- No calcula impuestos, prestaciones ni otros conceptos legales.

## Desarrollo local

`npm install`, configurar `ONEFIX_DATABASE_URL` con la conexión PostgreSQL de Neon y `ONEFIX_SETUP_TOKEN` con un valor privado, ejecutar `npm run dev` y abrir `http://localhost:5000`. El servidor exige las 19 tablas de `server/postgres-schema.sql` y se niega a arrancar si faltan. Para una base completamente nueva y vacía, `npm run db:init:pg` aplica el esquema una sola vez. No se importa `data.db` ni se copian registros ficticios. La primera cuenta será Gerencia; esta invita a Administración y Producción. Es opcional configurar `ONEFIX_EMAIL_DOMAIN`. Para compilar: `npm run check && npm run build`.

Los PIN demo conocidos (`0000`, `4826` y `7315`) están bloqueados en el servidor conectado a Neon. Para usar la aplicación real hay que crear usuarios con contraseñas personales de al menos 12 caracteres. No compartas `ONEFIX_DATABASE_URL` ni `ONEFIX_SETUP_TOKEN` en el navegador o en Git; configúralos como secretos del servidor.

El navegador registra un service worker que guarda la interfaz completa desde la primera visita con internet y conserva una copia local de la última vista. Si IndexedDB o el service worker están bloqueados por el navegador o la vista previa embebida, el modo sin conexión no está garantizado. Hay que iniciar sesión y abrir la app con internet una vez en cada dispositivo para preparar su copia local; una instalación nueva sin conexión no puede iniciar sesión. No existe sincronización entre dos dispositivos mientras ambos estén sin red; cada uno envía su cola cuando vuelve a conectarse.

En una prueba automatizada con tres contextos de navegador aislados (dos de Administración, móvil y escritorio, y uno de Gerencia), todos abrieron la app sin red tras una primera visita. Los dos primeros conservaron pagos locales incluso después de recargar y sincronizaron al reconectar. Dos intentos para la misma línea hechos en dispositivos distintos produjeron un pago confirmado y un conflicto que exige revisión; dos líneas distintas se registraron sin duplicarse. Un intento repetido en el mismo dispositivo quedó bloqueado y repetir una operación ya sincronizada devolvió el mismo resultado sin crear otro pago. Gerencia conservó la vista consultiva sin red. Esto no reemplaza una prueba en teléfonos y computadoras físicos ni valida todavía un alojamiento de producción.

Para la vista previa embebida, compila con `VITE_PREVIEW_MODE=1 npm run build`. Esa variante no incluye el almacenamiento local ni el modo sin conexión: registra pagos solamente cuando el servidor confirma la operación. La compilación normal es la versión PWA instalable, pero todavía no debe publicarse con datos reales.

### Almacenamiento persistente y despliegue

El backend utiliza `pg.Pool` y transacciones PostgreSQL. Un arranque sin conexión válida o con `ONEFIX_DEMO_ACCESS=1` falla de forma cerrada. El proyecto de Vercel todavía no está enlazado a este código ni tiene `ONEFIX_DATABASE_URL` configurada; esta migración del servidor no publica la app en Vercel. El sitio `pplx.app` anterior sigue siendo una beta ficticia separada y no debe utilizarse para personas reales. Se requieren pruebas del despliegue, respaldo y recuperación, gestión de secretos, revisión de seguridad y políticas de acceso antes del uso real.

### Preparación para Vercel

`vercel.json` compila la interfaz en `dist/public` y envía `/api/*` a la función `api/index.ts`; las rutas de la interfaz llegan a `index.html`. La función Express no abre un puerto y comprueba que existan las 19 tablas antes de responder. No se debe establecer `VITE_PREVIEW_MODE=1` en la compilación de Vercel, porque deshabilita la funcionalidad offline.

En las variables privadas del proyecto Vercel configurar `ONEFIX_DATABASE_URL` con la URL de la rama principal de Neon y `ONEFIX_SETUP_TOKEN` con un secreto aleatorio largo. No incluir estos valores en Git, en variables `VITE_*` ni en capturas de pantalla. No activar `ONEFIX_DEMO_ACCESS`: las claves demo de cuatro dígitos no sirven para uso real. Después del despliegue y con la base vacía, crear la cuenta inicial de Gerencia con un usuario y contraseña personal de 12 caracteres o más, e invitar a las otras áreas. Probar primero en un entorno de vista previa con datos ficticios; no registrar empleados reales hasta verificar seguridad, respaldos, recuperación y funcionamiento en los tres dispositivos.

El enlace y las variables privadas del proyecto Vercel aún no han sido configurados: el acceso CLI al equipo falla y la sesión Comet no está disponible. Estos archivos por sí solos no publican la aplicación.

## Límites antes de uso real

Esta es todavía una **beta con datos exclusivamente ficticios, no un sistema de nómina de producción**. Neon aporta almacenamiento persistente al backend, pero no resuelve por sí solo la protección de datos personales. La copia offline local está cifrada mediante un secreto del dispositivo y PIN, pero requiere revisión de seguridad y pruebas físicas en tres dispositivos antes de guardar datos reales. Falta desplegar y probar la app en Vercel, configurar copias de seguridad verificadas y recuperación de cuentas. Drive no almacena todavía las fotos ni los PDF. WhatsApp no envía avisos ni comprobantes automáticamente. Los PDF se generan al descargarlos y no se archivan automáticamente. El reporte contable es operativo y no genera asientos legales; falta un reporte de antigüedad de saldos. No introduzcas datos personales ni realices pagos reales hasta completar esos puntos y una revisión independiente.
