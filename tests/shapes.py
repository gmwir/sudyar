"""Mocked Digikala responses shaped like the official Swagger schemas (as relayed)."""


def commission_item(category_id=101, brand_id=5, brand_title="Bosch", commission=0.03, extra=0.01,
                    return_free=0.02, main=10, lead=2):
    return {"main_category_id": main, "category_id": category_id, "brand_id": brand_id,
            "brand_title": brand_title, "commission": commission, "extra_commission": extra,
            "return_free_commission": return_free, "currentLeadTime": lead}


def pager(page=1, total_pages=1, total_rows=0, size=50):
    return {"page": page, "item_per_page": size, "total_pages": total_pages, "total_rows": total_rows}


def commissions_page(items, page=1, total_pages=1):
    return {"data": {"items": items, "pager": pager(page, total_pages, len(items))}}


def sales_item(product_id=123, sold=40, amount=4_000_000, orders=30, visits=900, conv=3.3):
    return {"product_id": product_id, "net_item_sold": sold, "net_sales_amount": amount,
            "order_count": orders, "visit_count": visits, "conversion_rate": conv}


def sales_page(items, page=None, total_pages=None):
    data = {"items": items}
    if total_pages is not None:
        data["pager"] = pager(page or 1, total_pages, len(items))
    return {"data": data}
